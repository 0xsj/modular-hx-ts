import { DomainError } from '../errors/index.js'; // L0 -> L0, allowed
export const boom = (): DomainError => new DomainError();
