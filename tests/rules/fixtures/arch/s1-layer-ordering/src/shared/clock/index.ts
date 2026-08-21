import { pool } from '../postgres/index.js'; // L0 -> L2
export const now = (): unknown => pool;
