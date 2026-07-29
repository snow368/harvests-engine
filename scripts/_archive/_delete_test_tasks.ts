// Delete old test publish tasks
const resp = await fetch('http://localhost:3000/api/publish/tasks');
const data = await resp.json();
const testTasks = data.rows.filter((t: any) => t.payload?.test === true);
console.log('Found', testTasks.length, 'test tasks');
for (const t of testTasks) {
  await fetch(`http://localhost:3000/api/publish/tasks/${t.id}`, { method: 'DELETE' });
  console.log('Deleted:', t.id);
}
console.log('Done');
