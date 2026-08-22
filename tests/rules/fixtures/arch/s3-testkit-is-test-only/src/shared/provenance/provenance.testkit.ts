// A builder for a type whose real constructors are deliberately closed.
export const fakeProvenance = (): { requestId: string } => ({
  requestId: 'req_1',
});
