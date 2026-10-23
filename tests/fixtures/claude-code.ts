/** Never invoke the host CLI or inspect its login in application fixtures. */
export async function unavailableClaudeStatus() {
  return { available: false, loggedIn: false, subscription: false };
}
