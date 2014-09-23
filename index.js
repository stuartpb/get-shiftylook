#!/usr/bin/env node
'use strict';

var requestGet = require('request').get;
var cheerio = require('cheerio');
var Bottleneck = require('bottleneck');
var mkdirp = require('mkdirp');
var url = require('url');
var fs = require('fs');
var path = require('path');

var hostq = new Bottleneck(1, 10000);

var scope = 'http://www.shiftylook.com/comics/';

var outdir = __dirname + '/results';

var requested  = new Object(null);
var errors = new Object(null);
var retryLimit = 20;

function startsWith(s, prefix) {
  return s.slice(0,prefix.length) == prefix;
}

function savedFilename(fqurl) {
  return path.join(outdir, fqurl.replace(/^https?:\/\//,''));
}

function savedPagename(fqurl) {
  return path.join(savedFilename(fqurl), 'index.html');
}

function saveResponseBody(filename) {
  return function (err, res, body) {
    mkdirp.sync(path.dirname(filename));
    fs.writeFileSync(filename, body);
  };
}

function request(url, cb) {
  console.log('Requesting ' + url);
  requestGet(url, {encoding: null}, cb);
}

function retryingRequest(fqurl, cb) {
  function retry(err) {
    errors[fqurl] = errors[fqurl] || 0;
    if (++errors[fqurl] < retryLimit) {
      console.error('Received error for ' + fqurl + ', retrying: ', err);
      retryingRequest(fqurl,cb);
    } else {
      console.error('Error limit reached for ' + fqurl + ': ', err);
    }
  }
  function retryingCb(err, res, body) {
    if (err) {
      if (err.code == 'ETIMEDOUT' || err.code == 'ECONNRESET') {
        retry(err);
      } else {
        console.error('Unrecoverable error for ' + fqurl + ': ', err);
      }
    } else if (res.statusCode >= 400) {
      if (res.statusCode == 504) { // gateway timeout
        retry('HTTP 504');
      } else {
        console.error('Unrecoverable error for ' + fqurl +
          ': HTTP ' + res.statusCode);
      }
    } else {
      console.log('Received '+fqurl);
      return cb(err, res, body);
    }
  }
  var parsed = url.parse(fqurl);
  if (/amazonaws\.com$/.test(parsed.hostname)) {
    request(fqurl, retryingCb);
  } else if (/shiftylook\.com$/.test(parsed.hostname)) {
    console.log('Queueing request for '+ fqurl);
    hostq.submit(request, fqurl, retryingCb);
  }
}

function requestAsset(fqurl) {
  var filename = savedFilename(fqurl);

  // don't re-request assets
  if (requested[filename]) return;

  requested[filename] = true;

  // existing assets have already been requested
  if (fs.existsSync(filename)) return;

  return retryingRequest(fqurl, saveResponseBody(filename));
}

function parsePage(body,pageurl) {
  var $ = cheerio.load(body);
  function requestAttr(attr, requestor) {
    return function (i, el) {
      var attrurl = $(el).attr(attr);
      if (attrurl) {
        requestor(url.resolve(pageurl, attrurl));
      }
    };
  }
  // TODO: request assets in CSS
  $('head link').each(requestAttr('href', requestAsset));
  $('script, body img').each(requestAttr('src', requestAsset));
  $('body a').each(requestAttr('href', requestPage));
}

function receivePage(filename,fqurl) {
  return function (err, res, body) {
    parsePage(body,fqurl);
    // TODO: filename should really be decided more around here -
    // it's possible a page could hyperlink to non-HTML content
    // Could also do a thing with requesting CSS using this function
    mkdirp.sync(path.dirname(filename));
    fs.writeFileSync(filename, body);
  };
}

function requestPage(fqurl) {
  // only request pages within scope
  if (!startsWith(fqurl, scope)) return;

  var filename = savedPagename(fqurl);

  // don't re-request assets
  if (requested[filename]) return;

  requested[filename] = true;

  // existing pages have already been requested
  if (fs.existsSync(filename)) {
    // TODO: stat the savedFilename, and only do this for savedPagename
    // if savedFilename is a directory and savedPagename exists
    return parsePage(fs.readFileSync(filename),fqurl);
  } else {
    return retryingRequest(fqurl, receivePage(filename,fqurl));
  }
}

requestPage(scope);
