const ShardClient = require('../shard_client');
const assert      = require('chai').assert;
const _           = require('lodash');
const proxyquire  = require('proxyquire').noPreserveCache();


describe('ShardClient', function() {
  it('should fail if shard is not specified', function() {
    assert.throws(() => new ShardClient(), /shard is required/);
    assert.throws(() => new ShardClient({}), /shard is required/);
    assert.throws(() => new ShardClient({ shard: {} }), /unsupported shard configuration/);
  });

  function ShardClientCtor(client) {
    return proxyquire('../shard_client', {
      './client': client
    });
  }

  it('should fail when no shards are available', function(done) {
    const client = function(params) {
      this.host = params.host;
    };

    const ShardClient = ShardClientCtor(client);

    const shardClient = new ShardClient({
      shard: { hosts: [ ] }
    });

    shardClient.put('test', 'foo', (err) => {
      assert.match(err.message, /no shard available/);
      done();
    });
  });

  it('should work when full url are provided', function() {
    const client = function(params) {
      this.host = params.host;
    };

    const ShardClient = ShardClientCtor(client);

    const shardClient = new ShardClient({
      shard: { hosts: [ 'limitd://host-2:9231', 'limitd://host-1:9231' ] }
    });

    assert.equal(shardClient.clients['host-1:9231'].host, 'limitd://host-1:9231');
    assert.equal(shardClient.clients['host-2:9231'].host, 'limitd://host-2:9231');
    assert.ok(shardClient.ring.servers.some(s => s.host === 'host-1' && s.port === 9231));
    assert.ok(shardClient.ring.servers.some(s => s.host === 'host-2' && s.port === 9231));
  });

  it('should create a new client for each host', function() {
    const client = function(params) {
      this.host = params.host;
    };

    const ShardClient = ShardClientCtor(client);

    const shardClient = new ShardClient({
      shard: { hosts: [ 'host-2', 'host-1' ] }
    });

    assert.equal(shardClient.clients['host-1:9231'].host, 'limitd://host-1:9231');
    assert.equal(shardClient.clients['host-2:9231'].host, 'limitd://host-2:9231');
  });

  ['take', 'put', 'wait', 'status', 'on', 'once', 'ping'].forEach(method => {
    it(`should define ${method}`, function() {
      const shardClient = new ShardClient({
        client: ()=>{},
        shard: { hosts: [ 'host-1', 'host-2' ] }
      });
      assert.isFunction(shardClient[method]);
    });
  });


  it('should invoke PUT on the client based on the hash', function(done) {
    const client = function(params) {
      this.host = params.host;
      this.put = function(type, key, count, callback) {
        assert.equal(this.host, 'limitd://host-1:9231');
        assert.equal(type, 'ip');
        assert.equal(key, '10.0.0.1');
        assert.equal(count, 1);
        assert.isFunction(callback);
        done();
      };
    };

    const ShardClient = ShardClientCtor(client);

    const shardClient = new ShardClient({
      client,
      shard: { hosts: [ 'host-1', 'host-2' ] }
    });

    shardClient.put('ip', '10.0.0.1', 1, _.noop);
  });

  it('should invoke TAKE on the client based on the hash', function(done) {
    const client = function(params) {
      this.host = params.host;
      this.take = function(type, key, count, callback) {
        assert.equal(this.host, 'limitd://host-1:9231');
        assert.equal(type, 'ip');
        assert.equal(key, '10.0.0.2');
        assert.equal(count, 1);
        assert.isFunction(callback);
        done();
      };
    };

    const ShardClient = ShardClientCtor(client);

    const shardClient = new ShardClient({
      shard: { hosts: [ 'host-1', 'host-2' ] }
    });

    shardClient.take('ip', '10.0.0.2', 1, _.noop);
  });

  it('should invoke PUT on the client based on the hash (2)', function(done) {
    const client = function(params) {
      this.host = params.host;
      this.put = function(type, key, count, callback) {
        assert.equal(this.host, 'limitd://host-1:9231');
        assert.equal(type, 'ip');
        assert.equal(key, '10.0.0.2');
        assert.equal(count, 1);
        assert.isFunction(callback);
        done();
      };
    };

    const ShardClient = ShardClientCtor(client);

    const shardClient = new ShardClient({
      shard: { hosts: [ 'host-1', 'host-2' ] }
    });

    shardClient.put('ip', '10.0.0.2', 1, _.noop);
  });

  it('should call every host on status', function(done) {
    const client = function(params) {
      this.host = params.host;
      this.status = function(type, prefix, callback) {
        if (this.host === 'limitd://host-1:9231') {
          callback(null, {
            items: [
              { instance: `item1-from-host-1` }
            ]
          });
        } else {
          callback(null, {
            items: [
              { instance: `item2-from-host-2` }
            ]
          });
        }
      };
    };

    const ShardClient = ShardClientCtor(client);

    const shardClient = new ShardClient({
      shard: { hosts: [ 'host-1', 'host-2' ] }
    });
    // Mock routing
    shardClient.getDestinationClient = function(type, key) {
      if (key === 'item1-from-host-1') {
        return this.clients['host-1:9231'];
      } else {
        return this.clients['host-2:9231'];
      }
    }

    shardClient.status('ip', '10.0.0.2', (err, response) => {
      if (err) { return done(err); }

      assert.include(response.items, { instance: `item1-from-host-1` });
      assert.include(response.items, { instance: `item2-from-host-2` });
      done();
    });
  });

  describe('when adding a new host to the shard', function() {
    it('should not return instances from hosts that does not hold the instance anymore', function(done) {
      const client = function(params) {
        this.host = params.host;
        this.status = function(type, prefix, callback) {
          // All hosts returns the same instances, the shard client must select
          // the status of the host that currently must host the instance
          callback(null, {
              items: [
                {
                  instance: 'ip|1|' + this.host,
                  remaining: 10,
                  reset: 0,
                  limit: 10
                },
                {
                  instance: 'ip|2|' + this.host,
                  remaining: 10,
                  reset: 0,
                  limit: 10
                }
              ]
          });
        };
      };

      const dns = {
        resolve: (address, type, callback) => {
          callback(null, [ 'host-b', 'host-a' ]);
        }
      };

      const SharedClient = proxyquire('../shard_client', {
        './client': client,
        'dns': dns
      });

      const shardClient = new SharedClient({
        shard: {
          autodiscover: {
            address: 'foo.bar.company.example.com'
          }
        }
      });

      // Mock routing
      shardClient.getDestinationClient = function(type, key) {
        if (key === 'ip|1|limitd://host-a:9231') {
          return this.clients['host-a:9231'];
        } else if (key === 'ip|2|limitd://host-b:9231') {
          return this.clients['host-b:9231'];
        }
      }

      shardClient.status('ip', '10.0.0.2', (err, response) => {
        if (err) { return done(err); }

        assert.deepEqual(response, {
          items: [
            { instance: 'ip|2|limitd://host-b:9231', remaining: 10, reset: 0, limit: 10 },
            { instance: 'ip|1|limitd://host-a:9231', remaining: 10, reset: 0, limit: 10 }
          ],
          errors: []
        });

        done();
      });
    });
  });

  it('should swallow error from client on status', function(done) {
    const client = function(params) {
      this.host = params.host;
      this.status = function(type, prefix, callback) {
        if (this.host === 'limitd://host-2:9231') {
          return callback(new Error('unreachable'));
        }
        callback(null, {
          items: [
            `item1-from-${this.host}`,
            `item2-from-${this.host}`
          ]
        });
      };
    };

    const ShardClient = ShardClientCtor(client);

    const shardClient = new ShardClient({
      shard: { hosts: [ 'host-1', 'host-2' ] }
    });

    shardClient.status('ip', '10.0.0.2', (err, response) => {
      if (err) { return done(err); }
      assert.equal(response.errors[0].message, 'unreachable');
      assert.include(response.items, 'item1-from-limitd://host-1:9231');
      assert.include(response.items, 'item2-from-limitd://host-1:9231');
      assert.notInclude(response.items, 'item1-from-limitd://host-2:9231');
      assert.notInclude(response.items, 'item2-from-limitd://host-2:9231');
      done();
    });
  });

  it('should ping all hosts on ping', function(done) {
    const pinged = [];
    const client = function(params) {
      this.host = params.host;
      this.ping = function(callback) {
        pinged.push(this.host);
        callback(null, {});
      };
    };

    const ShardClient = ShardClientCtor(client);

    const shardClient = new ShardClient({
      shard: { hosts: [ 'host-1', 'host-2' ] }
    });

    shardClient.ping((err) => {
      if (err) { return done(err); }
      assert.equal(pinged[0], 'limitd://host-1:9231');
      assert.equal(pinged[1], 'limitd://host-2:9231');
      done();
    });
  });


  it('should autodiscover limitd shards', function() {
    const client = function(params) {
      this.host = params.host;
    };

    const dns = {
      resolve: (address, type, callback) => {
        assert.equal(address, 'foo.bar.company.example.com');
        assert.equal(type, 'A');
        callback(null, [ 'host-b', 'host-a' ]);
      }
    };

    const SharedClient = proxyquire('../shard_client', {
      './client': client,
      'dns': dns
    });

    const shardClient = new SharedClient({
      shard: {
        autodiscover: {
          address: 'foo.bar.company.example.com'
        }
      }
    });

    assert.equal(shardClient.clients['host-a:9231'].host, 'limitd://host-a:9231');
    assert.equal(shardClient.clients['host-b:9231'].host, 'limitd://host-b:9231');
    assert.ok(shardClient.ring.servers.some(s => s.host === 'host-b' && s.port === 9231));
    assert.ok(shardClient.ring.servers.some(s => s.host === 'host-a' && s.port === 9231));
  });

  it('should add new shards', function(done) {
    var clientsCreated = 0;
    const client = function(params) {
      clientsCreated++;
      this.host = params.host;
    };

    var resolveCalls = 0;

    const dns = {
      resolve: (address, type, callback) => {
        assert.equal(address, 'foo.bar.company.example.com');
        assert.equal(type, 'A');
        resolveCalls++;
        if (resolveCalls === 1)  {
          callback(null, [ 'host-b', 'host-a' ]);
        } else if (resolveCalls === 2)  {
          callback(null, [ 'host-c', 'host-b', 'host-a' ]);
        }
      }
    };

    const SharedClient = proxyquire('../shard_client', {
      './client': client,
      'dns': dns
    });

    const shardClient = new SharedClient({
      shard: {
        autodiscover: {
          refreshInterval: 10,
          address: 'foo.bar.company.example.com'
        }
      }
    });


    shardClient.on('new client', () => {
      if (resolveCalls === 1) {
        assert.equal(shardClient.ring.servers.length, 2);
        assert.equal(clientsCreated, 2);
      } else {
        assert.equal(shardClient.ring.servers.length, 3);
        assert.equal(clientsCreated, 3);
        assert.equal(shardClient.clients['host-a:9231'].host, 'limitd://host-a:9231');
        assert.equal(shardClient.clients['host-b:9231'].host, 'limitd://host-b:9231');
        assert.equal(shardClient.clients['host-c:9231'].host, 'limitd://host-c:9231');
        assert.ok(shardClient.ring.servers.some(s => s.host === 'host-c' && s.port === 9231));
        assert.ok(shardClient.ring.servers.some(s => s.host === 'host-b' && s.port === 9231));
        assert.ok(shardClient.ring.servers.some(s => s.host === 'host-a' && s.port === 9231));
        done();
      }
    });
  });

  it('should remove shards', function(done) {
    var clientsCreated = 0;
    var clients = [];
    const client = function(params) {
      clientsCreated++;
      this.host = params.host;
      this.disconnect = () => this.disconnected = true;
      clients.push(this);
    };

    var resolveCalls = 0;

    const dns = {
      resolve: (address, type, callback) => {
        assert.equal(address, 'foo.bar.company.example.com');
        assert.equal(type, 'A');
        resolveCalls++;
        if (resolveCalls === 1)  {
          callback(null, [ 'host-b', 'host-a' ]);
        } else if (resolveCalls === 2)  {
          callback(null, [ 'host-a' ]);
        }
      }
    };

    const SharedClient = proxyquire('../shard_client', {
      './client': client,
      'dns': dns
    });

    const shardClient = new SharedClient({
      shard: {
        autodiscover: {
          refreshInterval: 10,
          address: 'foo.bar.company.example.com'
        }
      }
    });


    shardClient.once('new client', () => {
      assert.equal(shardClient.ring.servers.length, 2);
      assert.equal(clientsCreated, 2);
    }).once('removed client', () => {
      assert.equal(shardClient.ring.servers.length, 1);
      assert.equal(clientsCreated, 2);
      assert.equal(shardClient.clients['host-a:9231'].host, 'limitd://host-a:9231');
      assert.notOk(shardClient.ring.servers.some(s => s.host === 'host-b' && s.port === 9231));
      assert.ok(shardClient.ring.servers.some(s => s.host === 'host-a' && s.port === 9231));
      assert.ok(clients.some(c => c.disconnected && c.host === 'limitd://host-b:9231'));
      assert.ok(clients.some(c => !c.disconnected && c.host === 'limitd://host-a:9231'));
      done();
    });
  });




});
