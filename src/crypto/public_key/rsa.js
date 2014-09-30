// GPG4Browsers - An OpenPGP implementation in javascript
// Copyright (C) 2011 Recurity Labs GmbH
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 3.0 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
//
// RSA implementation

/**
 * @requires crypto/public_key/jsbn
 * @requires crypto/random
 * @requires util
 * @module crypto/public_key/rsa
 */

var BigInteger = require('./jsbn.js'),
  util = require('../../util.js'),
  random = require('../random.js'),
  config = require('../../config');

function SecureRandom() {
  function nextBytes(byteArray) {
    for (var n = 0; n < byteArray.length; n++) {
      byteArray[n] = random.getSecureRandomOctet();
    }
  }
  this.nextBytes = nextBytes;
}

var blinder = BigInteger.ZERO;
var unblinder = BigInteger.ZERO;

function blind(m, n, e) {
  if (unblinder.bitLength() === n.bitLength()) {
    unblinder = unblinder.square().mod(n);
  } else {
    unblinder = random.getRandomBigIntegerInRange(BigInteger.TWO, n);
  }
  blinder = unblinder.modInverse(n).modPow(e, n);
  return m.multiply(blinder).mod(n);
}

function unblind(t, n) {
  return t.multiply(unblinder).mod(n);
}

function RSA() {
  /**
   * This function uses jsbn Big Num library to decrypt RSA
   * @param m
   *            message
   * @param n
   *            RSA public modulus n as BigInteger
   * @param e
   *            RSA public exponent as BigInteger
   * @param d
   *            RSA d as BigInteger
   * @param p
   *            RSA p as BigInteger
   * @param q
   *            RSA q as BigInteger
   * @param u
   *            RSA u as BigInteger
   * @return {BigInteger} The decrypted value of the message
   */
  function decrypt(m, n, e, d, p, q, u) {
    if (config.rsa_blinding) {
      m = blind(m, n, e);
    }
    var xp = m.mod(p).modPow(d.mod(p.subtract(BigInteger.ONE)), p);
    var xq = m.mod(q).modPow(d.mod(q.subtract(BigInteger.ONE)), q);
    util.print_debug("rsa.js decrypt\nxpn:" + util.hexstrdump(xp.toMPI()) + "\nxqn:" + util.hexstrdump(xq.toMPI()));

    var t = xq.subtract(xp);
    if (t[0] === 0) {
      t = xp.subtract(xq);
      t = t.multiply(u).mod(q);
      t = q.subtract(t);
    } else {
      t = t.multiply(u).mod(q);
    }
    t = t.multiply(p).add(xp);
    if (config.rsa_blinding) {
      t = unblind(t, n);
    }
    return t;
  }

  /**
   * encrypt message
   * @param m message as BigInteger
   * @param e public MPI part as BigInteger
   * @param n public MPI part as BigInteger
   * @return BigInteger
   */
  function encrypt(m, e, n) {
    return m.modPowInt(e, n);
  }

  /* Sign and Verify */
  function sign(m, d, n) {
    return m.modPow(d, n);
  }

  function verify(x, e, n) {
    return x.modPowInt(e, n);
  }

  // "empty" RSA key constructor

  function keyObject() {
    this.n = null;
    this.e = 0;
    this.ee = null;
    this.d = null;
    this.p = null;
    this.q = null;
    this.dmp1 = null;
    this.dmq1 = null;
    this.u = null;
  }

  // Generate a new random private key B bits long, using public expt E

  function generate(B, E, callback) {

    //
    // Native RSA keygen using Web Crypto
    //

    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      var keyGenOpt = {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: B, // the specified keysize in bits
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),  // Equivalent to 65537, TODO: use provided argument E
        hash: {
          name: 'SHA-256' // not required for actual RSA keys, but for crypto api 'sign' and 'verifiy'
        }
      };

      var extractable = true; // make generated key extractable

      window.crypto.subtle.generateKey(keyGenOpt, extractable, ['sign', 'verify'])
        .then(onGenerated, onError)
        .then(onExported, onError);

      return;
    }

    function onError() {
      callback(new Error('Generating key failed!'));
    }

    function onGenerated(key) {
      // export the generated keys as JsonWebKey (JWK)
      // https://tools.ietf.org/html/draft-ietf-jose-json-web-key-33
      return window.crypto.subtle.exportKey('jwk', key.privateKey);
    }

    function onExported(jwk) {
      // map JWK parameters to local BigInteger type system
      var key = new keyObject();
      key.n = new BigInteger(util.hexstrdump(base64(jwk.n)), 16);
      key.ee = new BigInteger(E, 16);
      key.d = new BigInteger(util.hexstrdump(base64(jwk.d)), 16);
      key.p = new BigInteger(util.hexstrdump(base64(jwk.p)), 16);
      key.q = new BigInteger(util.hexstrdump(base64(jwk.q)), 16);
      key.u = key.p.modInverse(key.q);

      function base64(base64url) {
        return base64url.replace(/-/g, '+').replace(/_/g, '/');
      }

      callback(null, key);
    }

    //
    // JS code
    //

    var key = new keyObject();
    var rng = new SecureRandom();
    var qs = B >> 1;
    key.e = parseInt(E, 16);
    key.ee = new BigInteger(E, 16);
    for (;;) {
      for (;;) {
        key.p = new BigInteger(B - qs, 1, rng);
        if (key.p.subtract(BigInteger.ONE).gcd(key.ee).compareTo(BigInteger.ONE) === 0 && key.p.isProbablePrime(10))
          break;
      }
      for (;;) {
        key.q = new BigInteger(qs, 1, rng);
        if (key.q.subtract(BigInteger.ONE).gcd(key.ee).compareTo(BigInteger.ONE) === 0 && key.q.isProbablePrime(10))
          break;
      }
      if (key.p.compareTo(key.q) <= 0) {
        var t = key.p;
        key.p = key.q;
        key.q = t;
      }
      var p1 = key.p.subtract(BigInteger.ONE);
      var q1 = key.q.subtract(BigInteger.ONE);
      var phi = p1.multiply(q1);
      if (phi.gcd(key.ee).compareTo(BigInteger.ONE) === 0) {
        key.n = key.p.multiply(key.q);
        key.d = key.ee.modInverse(phi);
        key.dmp1 = key.d.mod(p1);
        key.dmq1 = key.d.mod(q1);
        key.u = key.p.modInverse(key.q);
        break;
      }
    }

    callback(null, key);
  }

  this.encrypt = encrypt;
  this.decrypt = decrypt;
  this.verify = verify;
  this.sign = sign;
  this.generate = generate;
  this.keyObject = keyObject;
}

module.exports = RSA;
