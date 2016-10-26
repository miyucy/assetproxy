const process = require('process');
const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');
const redis = require('redis');

const HOSTS = process.env.HOSTS.split(',');
const REDIS = redis.createClient(process.env.REDIS_URL || 'redis://127.0.0.1:6379/0');
const ONEDAY = 60 * 60 * 24;
const LIFETIME = ONEDAY * parseInt(process.env.LIFETIME || '14', 10);

function httpRequest(host, path, success, error) {
  const uri = url.parse(host);
  const port = uri.protocol === 'https:' ? 443 : 80;
  const headers = {
    accept: '*/*', 'accept-encoding': 'gzip',
  };
  const options = {
    hostname: uri.hostname,
    port, headers, path,
    timeout: 10 * 1000,
  };

  const request = (port === 80 ? http : https).request(options, (response) => {
    console.log('response', response.statusCode, options.hostname, options.path);
    if (response.statusCode === 200) {
      success([host, response]);
    } else {
      response.destroy();
      error(new Error('Not OK'));
    }
  });
  request.on('error', error);
  request.end();
}

// req == http.IncomingMessage
// res == http.ServerResponse
http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 400;
    res.end();
    return;
  }

  if (process.env.AUTHORIZATION && process.env.AUTHORIZATION.length > 0) {
    if (req.headers.authorization !== process.env.AUTHORIZATION) {
      res.statusCode = 401;
      res.end();
      return;
    }
  }

  console.log('request', req.url);

  REDIS.get(req.url, (err, cachedHost) => {
    let hosts = null;

    if (cachedHost) {
      hosts = [cachedHost];
    } else {
      hosts = [...HOSTS];
    }

    let errors = null;
    const success = new Promise((success) => {
      errors = hosts.map((host) => (
        new Promise((error) => (
          httpRequest(host, req.url, success, error)
        ))
      ));
    });

    let errorEnded = false;
    success.then(wrapper => {
      const host = wrapper[0];
      const response = wrapper[1];

      REDIS.set([req.url, host, 'EX', `${LIFETIME}`]);

      res.statusCode = response.statusCode;
      res.setHeader('Connection', 'close');

      {
        const headers = response.headers;
        ['Content-Type', 'Cache-Control', 'Date', 'ETag', 'Last-Modified'].forEach(name => {
          const key = name.toLowerCase();
          const value = headers[key];
          if (value && value.length > 0) {
            res.setHeader(name, value);
          }
        });
      }

      let piped = response;

      {
        const reqAcceptEncoding = req.headers['accept-encoding'] || '';
        const resContentEncoding = response.headers['content-encoding'] || '';

        if (reqAcceptEncoding.includes('gzip')) {
          res.setHeader('Content-Encoding', 'gzip');
          if (!resContentEncoding.includes('gzip')) {
            piped = piped.pipe(zlib.createGzip());
          }
        } else {
          if (resContentEncoding.includes('gzip')) {
            piped = piped.pipe(zlib.createGunzip());
          }
        }
      }

      piped.pipe(res);
    }).catch((err) => {
      if (!errorEnded) {
        console.log('err', err);
        res.statusCode = 500;
        res.end();
        errorEnded = true;
      }
    });

    Promise.all(errors).then(() => new Error('Not Found')).catch((err) => {
      if (!errorEnded) {
        console.log('err', err);
        res.statusCode = 404;
        res.end();
        errorEnded = true;
      }
    });
  });
}).listen(process.env.PORT);
