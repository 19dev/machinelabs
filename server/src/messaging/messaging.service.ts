import * as firebase from 'firebase';
import { Crypto } from '../util/crypto';
import { environment } from '../environments/environment';
import { db, dbRefBuilder } from '../ml-firebase/db';
import { CodeRunner, ProcessStreamData } from '../code-runner/code-runner';
import { Observable } from '@reactivex/rxjs';
import { Invocation, InvocationType } from '../models/invocation';
import { Execution, ExecutionStatus } from '@machinelabs/core';
import { ExecutionMessage, MessageKind, toMessageKind } from '../models/execution';
import { ValidationService } from '../validation/validation.service';
import { Server } from '../models/server';
import { ValidationContext } from '../validation/validation-context';
import { LabConfigResolver } from '../validation/resolver/lab-config-resolver';
import { ExecutionResolver } from '../validation/resolver/execution-resolver';
import { RecycleService } from './recycling/recycle.service';

const MAX_MESSAGES_COUNT = 10000;

export class MessagingService {

  server: Server;

  constructor(private startValidationService: ValidationService,
              private stopValidationService: ValidationService,
              private recycleService: RecycleService,
              private codeRunner: CodeRunner) {
  }

  init() {

    dbRefBuilder.serverRef(environment.serverId).onceValue()
        .map(snapshot => snapshot.val())
        .subscribe(server => {
          this.server = server;
          this.initMessaging();
        });
  }

  initMessaging () {

    // Share one subscription to all incoming messages
    let newInvocations$ = dbRefBuilder.newInvocationsForServerRef(this.server.id)
                                 .childAdded()
                                 .map(snapshot => snapshot.val().common)
                                 .share();

    // Invoke new processes for incoming StartExecution Invocations
    newInvocations$
    .filter((invocation: Invocation) => invocation.type === InvocationType.StartExecution)
    .subscribe(invocation => {

      this.getOutputAsObservable(invocation)
          .flatMap(data => this.handleOutput(data.message, data.invocation))
          .subscribe(null, (error) => {
            console.error(`Message processing of execution ${invocation.id} ended unexpectedly at ${Date.now()}`);
            console.error(error);
            console.log(`Stopping execution ${invocation.id} now`);
            this.codeRunner.stop(invocation.id);
            this.completeExecution(invocation, ExecutionStatus.Failed);
          }, () => {
            console.log(`Message stream completed for execution ${invocation.id} at ${Date.now()}`);
          });
    });


    newInvocations$
      .filter((invocation: Invocation) => invocation.type === InvocationType.StopExecution)
      .flatMap(invocation => this.stopValidationService.validate(invocation))
      .subscribe(validationContext => {
          let execution = validationContext.resolved.get(ExecutionResolver);
          if (validationContext.isApproved() && execution) {
            this.codeRunner.stop(execution.id);
          } else {
            console.log('Request to stop invocation was invalid');
          }
        });
  }

  /**
   * Take a run and observe the output. The run maybe cached or rejected
   * but it is guaranteed to get some message back.
   */
  getOutputAsObservable(invocation: Invocation): Observable<{message: ExecutionMessage, invocation: Invocation}> {
    console.log(`Starting new run ${invocation.id}`);

    // check if we have existing output for the requested run
    let hash = Crypto.getCacheHash(invocation.data);
    // otherwise, try to get approval
    return this.startValidationService
      .validate(invocation)
      .switchMap(validationContext => {
        if (validationContext.isApproved() && validationContext.resolved.get(LabConfigResolver)) {
          // if we get the approval, create the meta data
          this.createExecutionAndUpdateLabs(invocation, hash);
          // and execute the code
          let config = validationContext.resolved.get(LabConfigResolver);

          return this.codeRunner
            .run(invocation, config)
            .map(data => this.processStreamDataToExecutionMessage(data))
            .startWith(<ExecutionMessage>{
              kind: MessageKind.ExecutionStarted,
              data: '\r\nExecution started... (this might take a little while)\r\n',
            })
            .concat(Observable.of(<ExecutionMessage>{
              kind: MessageKind.ExecutionFinished,
              data: '',
            }))
            .do(msg => {
              if (msg.kind === MessageKind.ExecutionFinished) {
                this.completeExecution(invocation);
              }
            })
            .let(msgs => this.recycleService.watch(invocation.id, msgs));
        }

        // if we don't get an approval, reject it
        return Observable.of(<ExecutionMessage>{
          kind: MessageKind.ExecutionRejected,
          data: validationContext.validationResult,
          index: 0,
          virtual_index: 0
        });
      })
      .map(msg => {
        msg.terminal_mode = true;
        return msg;
      })
      .map(message => ({ message, invocation }));
  }

  handleOutput(message: ExecutionMessage, invocation: Invocation) {
    if (message.index === MAX_MESSAGES_COUNT) {
      // If coincidentally this message will be the ExecutionFinished message,
      // things will still be ok because we don't change the `kind` which means
      // it gets written just fine (despite the changed data)
      message.data = 'Maximum output capacity reached. Process keeps going but no further output is saved.';
      return this.writeExecutionMessage(message, invocation);
    } else if (message.index > MAX_MESSAGES_COUNT && message.kind === MessageKind.ExecutionFinished) {
      return this.writeExecutionMessage(message, invocation);
    } else if (message.index <= MAX_MESSAGES_COUNT) {
      return this.writeExecutionMessage(message, invocation);
    }

    return  Observable.empty();
  }

  createExecutionAndUpdateLabs(invocation: Invocation, hash: string) {
    dbRefBuilder.executionRef(invocation.id)
      .set({
        id: invocation.id,
        cache_hash: hash,
        lab: invocation.data,
        server_info: `${this.server.name} (${this.server.hardware_type})`,
        hardware_type: this.server.hardware_type,
        server_id: this.server.id,
        started_at: firebase.database.ServerValue.TIMESTAMP,
        user_id: invocation.user_id,
        status: ExecutionStatus.Executing
      })
      .subscribe();
  }

  completeExecution(run: Invocation, status = ExecutionStatus.Finished) {
    dbRefBuilder.executionRef(run.id)
      .update({
        finished_at: firebase.database.ServerValue.TIMESTAMP,
        status: status
      });
  }

  processStreamDataToExecutionMessage(data: ProcessStreamData): ExecutionMessage {
    return {
      data: data.str,
      kind: toMessageKind(data.origin),
      terminal_mode: true
    };
  }

  writeExecutionMessage(data: ExecutionMessage, run: Invocation) {
    let id = db.ref().push().key;
    data.id = id;
    data.timestamp = firebase.database.ServerValue.TIMESTAMP;
    return dbRefBuilder.executionMessageRef(run.id, id).set(data);
  }
}
