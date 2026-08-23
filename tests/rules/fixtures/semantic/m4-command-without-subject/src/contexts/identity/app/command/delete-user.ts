// A mutating use case with no Subject. Ambient authorization would make this
// look identical to a checked one at every call site.
export async function deleteUser(userId: string): Promise<void> {
  void userId;
}
