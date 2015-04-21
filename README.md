[![Build Status](https://travis-ci.org/auth0/limitd.svg)](https://travis-ci.org/limitd/node-client)

limitd is a simple daemon for rate limiting highly available applications.

This repository contains the client library for node.js.

## Install

```
npm install limitd-client --save
```

## Example usage

```javascript
var limitd = new LimitdClient('limitd://localhost:9001');

//express middleware
app.use(function (req, res, next) {
  limitd.take('user', req.username, function (err, resp) {
    if (err) return next(err);

    res.set({
      'X-RateLimit-Limit':     resp.limit,
      'X-RateLimit-Remaining': resp.remaining,
      'X-RateLimit-Reset':     resp.reset
    });

    if (resp.conformant) return next();

    // The 429 status code indicates that the user has sent too many
    // requests in a given amount of time ("rate limiting").
    res.send('429');
  });
})
```

## API

### limitd.take(type, key, count?, callback)

Take if available `count` amount of tokens from the bucket with key `key` of type `type`.

count defaults to 1.

The callback will be call either with an Error object or a Response object.

-  `response.conformant`: boolean indicating if the traffic is conformant or not.
-  `response.limit`: indicates the size of this bucket.
-  `response.remaining`: the amount of remaining tokens in the bucket.
-  `response.reset`: a unix timestamp indicating when the bucket is going to be full again.
-  `response.delayed`: always false for TAKE requests.


### limitd.wait(type, key, count?, callback)

Take or Wait for `count` amount of tokens from the bucket with key `key` of type `type`.

count defaults to 1.

The callback will be call either with an Error object or a Response object.

-  `response.delayed`: boolean indicating if this request was delayed due to insufficient tokens in the bucket.
-  `response.limit`: indicates the size of this bucket.
-  `response.remaining`: the amount of remaining tokens in the bucket.
-  `response.reset`: a unix timestamp indicating when the bucket is going to be full again.
-  `response.conformant`: always true for WAIT requests.

### limitd.put(type, key, count?, callback) (alias reset)

Force put `count` amount of tokens in the bucket with key `key` of type `type`.

count defaults to the size of the bucket.

The callback will be call either with an Error object or a Response object.

-  `response.limit`: indicates the size of this bucket.
-  `response.remaining`: the amount of remaining tokens in the bucket.
-  `response.reset`: a unix timestamp indicating when the bucket is going to be full again.

This is useful for buckets that are not automatically filled or when the application needs to force a reset.

## License

MIT 2015 - AUTH0 INC.


