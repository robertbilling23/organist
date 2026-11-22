/**
 * Phase 0: Payload-First Security Test Specification for Lodge Music Firestore Rules.
 * Verifies the "Dirty Dozen" adversarial payloads against the Firestore Rules contract.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  path: string;
  operation: 'create' | 'update' | 'delete' | 'get' | 'list';
  auth: { uid: string; email: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Set Create',
    path: 'sets/hack',
    operation: 'create',
    auth: null,
    payload: { id: 'hack', label: 'Hack', order: 0 },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 2,
    name: 'Non-Admin Authenticated Track Create',
    path: 'sets/craft/tracks/evil',
    operation: 'create',
    auth: { uid: 'user_999', email: 'visitor@example.com', email_verified: true },
    payload: {
      id: 'evil',
      setId: 'craft',
      title: 'Evil Track',
      color: 'red',
      file: 'audio/evil.mp3',
      cue: '',
      lyrics: [],
      order: 0
    },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 3,
    name: 'Unverified Admin Email Spoof',
    path: 'sets/craft',
    operation: 'update',
    auth: { uid: 'spoof_1', email: 'robert.billing@gmail.com', email_verified: false },
    payload: { label: 'Spoofed' },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 4,
    name: 'Shadow Ghost Field Injection',
    path: 'sets/craft/tracks/track_ghost',
    operation: 'create',
    auth: { uid: 'owner_1', email: 'robert.billing@gmail.com', email_verified: true },
    payload: {
      id: 'track_ghost',
      setId: 'craft',
      title: 'Ghost',
      color: 'blue',
      file: 'audio/test.mp3',
      cue: 'Cue',
      lyrics: [],
      order: 0,
      ghostField: true
    },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 5,
    name: 'Path ID Poisoning (Oversized / Invalid Characters)',
    path: `sets/${'a'.repeat(150)}`,
    operation: 'create',
    auth: { uid: 'owner_1', email: 'robert.billing@gmail.com', email_verified: true },
    payload: { id: 'a'.repeat(150), label: 'Too Long', order: 0 },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 6,
    name: 'Mismatched Body ID vs Path ID',
    path: 'sets/craft',
    operation: 'create',
    auth: { uid: 'owner_1', email: 'robert.billing@gmail.com', email_verified: true },
    payload: { id: 'different_id', label: 'Mismatch', order: 0 },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 7,
    name: 'Orphaned Track Creation (Missing Parent Set)',
    path: 'sets/nonexistent_set/tracks/t1',
    operation: 'create',
    auth: { uid: 'owner_1', email: 'robert.billing@gmail.com', email_verified: true },
    payload: {
      id: 't1',
      setId: 'nonexistent_set',
      title: 'Orphan',
      color: 'blue',
      file: 'audio/test.mp3',
      cue: '',
      lyrics: [],
      order: 0
    },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 8,
    name: 'Cross-Set setId Forgery',
    path: 'sets/ea/tracks/t1',
    operation: 'create',
    auth: { uid: 'owner_1', email: 'robert.billing@gmail.com', email_verified: true },
    payload: {
      id: 't1',
      setId: 'craft',
      title: 'Forged Set',
      color: 'blue',
      file: 'audio/test.mp3',
      cue: '',
      lyrics: [],
      order: 0
    },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 9,
    name: 'Immutable createdAt / Spoofed Timestamp Tampering',
    path: 'sets/craft',
    operation: 'update',
    auth: { uid: 'owner_1', email: 'robert.billing@gmail.com', email_verified: true },
    payload: { label: 'Updated', createdAt: new Date(0).toISOString() },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 10,
    name: 'Invalid Button Color Enum',
    path: 'sets/craft/tracks/t_color',
    operation: 'create',
    auth: { uid: 'owner_1', email: 'robert.billing@gmail.com', email_verified: true },
    payload: {
      id: 't_color',
      setId: 'craft',
      title: 'Bad Color',
      color: 'neon-pink',
      file: 'audio/test.mp3',
      cue: '',
      lyrics: [],
      order: 0
    },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 11,
    name: 'Denial-of-Wallet Oversized Payload',
    path: 'sets/craft/tracks/t_huge',
    operation: 'create',
    auth: { uid: 'owner_1', email: 'robert.billing@gmail.com', email_verified: true },
    payload: {
      id: 't_huge',
      setId: 'craft',
      title: 'X'.repeat(500),
      color: 'blue',
      file: 'audio/test.mp3',
      cue: '',
      lyrics: Array.from({ length: 150 }, (_, i) => `Line ${i}`),
      order: 0
    },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 12,
    name: 'Privilege Escalation on /admins',
    path: 'admins/attacker_uid',
    operation: 'create',
    auth: { uid: 'attacker_uid', email: 'attacker@example.com', email_verified: true },
    payload: {
      uid: 'attacker_uid',
      email: 'attacker@example.com',
      role: 'admin'
    },
    expected: 'PERMISSION_DENIED'
  }
];
