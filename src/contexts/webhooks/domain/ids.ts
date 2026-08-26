/**
 * Typed ids. **`webhooks` domain.**
 *
 * Branded locally, because `S7` permits this directory exactly one import.
 */

declare const Brand: unique symbol;

type Branded<T, K extends string> = T & { readonly [Brand]: K };

export type EndpointId = Branded<string, 'EndpointId'>;
export type DeliveryId = Branded<string, 'DeliveryId'>;

export const endpointId = (raw: string): EndpointId => raw as EndpointId;
export const deliveryId = (raw: string): DeliveryId => raw as DeliveryId;
