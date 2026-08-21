import { raw } from '../postgres/pool.js'; // postgres is an implementation detail
export const publish = (): unknown => raw;
