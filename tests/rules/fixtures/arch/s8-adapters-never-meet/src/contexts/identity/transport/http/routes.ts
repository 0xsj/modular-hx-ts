import { repo } from '../../infra/memory/repo.js'; // driving adapter -> driven adapter
export const routes = (): unknown => repo;
