import { repo } from '../infra/memory/repo.js'; // app declares ports, root injects
export const run = (): unknown => repo;
