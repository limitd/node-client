'use strict';

const LimitdClient = require('../client');
const Transform = require('stream').Transform;
// const Writable = require('stream').Writable;
const _ = require('lodash');

class Sink extends Transform {
  constructor(waitFor) {
    super({ objectMode: true });
    this.count = 0;
    this.waitFor = waitFor;
  }

  _transform(chunk, encoding, callback) {
    this.count++;
    if (this.count >= this.waitFor) {
      this.emit('full');
    }
    callback();
  }
}

const reqCount = 1000000;

const sink = new Sink(reqCount);

const client = new LimitdClient({
  stream: sink
});

const start = process.hrtime();

sink.once('full', () => {
  const diff = process.hrtime(start);
  const ms = Math.ceil((diff[0] * 1e9 + diff[1]) / 1e6);
  console.log(`benchmark took ${ms} ms`);
  process.exit(0);
});

for(var i = 0; i < reqCount; i++) {
  client.take('foo', `test${i}`, _.noop);
}
