/** Future authenticated client integration. No desktop storage or IPC is accessed. */
export type ClientLearningGoal = { title: string; source: 'loginote-client'; updatedAt: string };
export interface LearningGoalPort {
  readCurrentGoal(): Promise<{ status: 'ready'; goal: ClientLearningGoal } | { status: 'not_configured' }>;
}
export const learningGoalPort: LearningGoalPort = {
  async readCurrentGoal() { return { status: 'not_configured' }; },
};
