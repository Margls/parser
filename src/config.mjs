import path from 'node:path';

export const ROOT_DIR = path.resolve(import.meta.dirname, '..');
export const AUTH_DIR = path.join(ROOT_DIR, '.auth', 'eisrf');
export const AUTH_STATE = path.join(ROOT_DIR, '.auth', 'eisrf-state.json');
export const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts');
export const LOGIN_URL = 'https://lk.eisrf.ru/user/login';
