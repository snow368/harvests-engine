fetch('http://localhost:3000/api/automation/tasks?status=failed')
  .then(r => r.json())
  .then(data => {
    const tasks = data.tasks || data || []
    const ids = tasks.map(t => t.id).filter(Boolean)
    console.log(`Found ${ids.length} failed tasks, resetting to pending...`)
    return Promise.all(ids.map(id =>
      fetch('http://localhost:3000/api/automation/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: id, status: 'pending' })
      })
    ))
  })
  .then(() => console.log('Done!'))
  .catch(console.error)
