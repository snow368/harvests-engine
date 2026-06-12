fetch('http://localhost:3000/api/automation/generate-from-competitors', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ accountType: 'supply_brand', limit: 3 })
})
.then(r => r.json())
.then(console.log)
.catch(console.error)
