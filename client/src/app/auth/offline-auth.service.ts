import { Injectable } from '@angular/core';

import { LoginUser } from '../models/user';
import { AuthService } from './auth.service';

import { Observable } from 'rxjs/Observable';
import { of } from 'rxjs/observable/of';
import { take } from 'rxjs/operators';

export let dummyUser = {
  id: 'some unique id',
  uid: 'some unique id',
  displayName: 'Tony Stark',
  email: 'tony@starkindustries.com',
  isAnonymous: true,
  photoURL: null,
  photoUrl: null
};

// We emulate the logged in user and its state of being
// anonymously authenticated or not
export interface OfflineAuth extends AuthService {
  user: LoginUser;
}

@Injectable()
export class OfflineAuthService implements OfflineAuth {
  user: LoginUser = dummyUser;

  requireAuth(): Observable<LoginUser> {
    return of(this.user);
  }

  requireAuthOnce(): Observable<LoginUser> {
    return this.requireAuth().pipe(take(1));
  }

  signInWithGitHub(): Observable<LoginUser> {
    this.user.isAnonymous = false;
    return of(this.user);
  }

  linkOrSignInWithGitHub(): Observable<LoginUser> {
    return this.signInWithGitHub();
  }

  signOut(): Observable<any> {
    this.user.isAnonymous = true;
    return of();
  }
}
