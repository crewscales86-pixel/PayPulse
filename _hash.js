const bcrypt = require('bcrypt');
const hash = bcrypt.hashSync('test123', 10);
console.log(hash);
