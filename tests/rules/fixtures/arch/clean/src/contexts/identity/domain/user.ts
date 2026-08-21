import { DomainError } from '../../../shared/errors/index.js'; // the one import domain/ may make
export const reject = (): DomainError => new DomainError();
