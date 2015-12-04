var EventEmitter = require('events').EventEmitter;
var async        = require('async');
var LimitdClient = require('./client');
var _            = require('lodash');
var util         = require('util');

function LimitdPool (options, done) {
  EventEmitter.call(this);

  var size = options.size || 5;
  var created = 0;
  var clients = this._clients = [];

  done = done || _.noop;

  this._current_client = 0;

  var pool = this;

  async.whilst(
    function () { return created < size; },
    function (done) {
      var client = new LimitdClient(options, function (err) {
        created++;

        if (err) {
          return done(err);
        }

        client.on('error', function (err) {
          pool.emit('error', err, client);
        });

        clients.push(client);
        done();
      });
    }, done);
}

util.inherits(LimitdPool, EventEmitter);

LimitdPool.prototype._getClient = function () {
  if (this._clients.length === 0) {
    return;
  }

  this._current_client++;

  if (this._current_client >= this._clients.length) {
    this._current_client = 0;
  }

  return this._clients[this._current_client];
};

Object.keys(LimitdClient).forEach(function (method) {
  LimitdPool.prototype[method] = function () {
   var client = this._getClient();
   client[method].apply(client, arguments);
  };
});

module.exports = LimitdPool;