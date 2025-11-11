const express = require('express');
const app = express();
const port = 3000;
app.get('/', (req, res) => {
  res.send('Hello World!');
});

const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 3, name: 'Charlie' }
]

app.get('/users', (req, res) => {
  res.json(users);
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});