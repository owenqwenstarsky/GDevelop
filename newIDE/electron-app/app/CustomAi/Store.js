const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const assertId = id => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new Error('Invalid local AI identifier.');
  return id;
};
class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  file(id) {
    return path.join(this.root, assertId(id) + '.json');
  }
  read(id) {
    return JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
  }
  write(id, data) {
    const file = this.file(id);
    const temporary = file + '.' + randomUUID() + '.tmp';
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(data));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  list() {
    return fs
      .readdirSync(this.root)
      .filter(name => name.endsWith('.json'))
      .map(name => this.read(name.slice(0, -5)));
  }
  delete(id) {
    fs.unlinkSync(this.file(id));
  }
}
module.exports = { Store, assertId };
