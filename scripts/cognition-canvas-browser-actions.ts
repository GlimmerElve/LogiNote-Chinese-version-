/** Shared user-facing canvas entry points for browser regression checks. */
export async function cognitionNodeAction(page: any, label: string) {
  const node = page.locator('.cm-node.selected:not(.cm-group)');
  await node.press('Shift+F10');
  await page.getByRole('menu', { name: '认知块操作', exact: true }).getByRole('menuitem', { name: label, exact: true }).click();
}
export async function cognitionRelationAction(page: any, relation: any, label: string) {
  const id = await relation.getAttribute('data-edge-id');
  if (!id) throw new Error('Expected an exact managed relationship identity');
  await page.getByTestId(`rf__edge-${id}`).press('Shift+F10');
  await page.getByRole('menu', { name: '关系操作', exact: true }).getByRole('menuitem', { name: label, exact: true }).click();
}
export async function cognitionUpdateOperation(editor: any, operation: string) {
  const select = editor.getByLabel('如何更新', { exact: true });
  if (!await select.isVisible()) await editor.getByText(/^特殊更新方式/u).click();
  await select.selectOption(operation);
}
export async function cognitionSelectEndpoint(dialog: any, label: string, nodeId: string, query = '') {
  const change = dialog.getByRole('button', { name: `更换${label}`, exact: true });
  if (await change.count()) await change.click();
  const input = dialog.getByRole('combobox', { name: label, exact: true });
  await input.fill(query);
  await dialog.locator(`[role="option"][data-node-id=${JSON.stringify(nodeId)}]`).click();
}
