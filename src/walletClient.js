'use strict'

const socket = require('socket.io-client')
const EventEmitter = require('events').EventEmitter
const inherits = require('inherits')
const sendPayment = require('five-bells-sender')
const request = require('superagent')
const WebFinger = require('webfinger.js')
const debug = require('debug')('WebTorrentIlp:WalletClient')

/**
 * Client for connecting to the five-bells-wallet
 * @param {String} opts.address
 * @param {String} opts.password
 */
function WalletClient (opts) {
  EventEmitter.call(this)

  this.address = opts.address
  this.password = opts.password
  this.account = null

  // TODO these should be removed once the wallet returns the right values from webfinger
  this.walletUri = 'https://' + opts.address.split('@')[1]
  this.username = opts.address.split('@')[0]

  this.socket = null
  this.ready = false
}

inherits(WalletClient, EventEmitter)

WalletClient.prototype.connect = function () {
  const _this = this

  debug('Account address:', this.address)
  return webfingerAddress(this.address)
    .then(function (account) {
      _this.account = account

      debug('Attempting to connect to wallet: ' + _this.walletUri + '/api/socket.io')
      _this.socket = socket(_this.walletUri, { path: '/api/socket.io' })
      _this.socket.on('connect', function () {
        debug('Connected to wallet API socket.io')
        _this.ready = true
        _this.emit('ready')
        _this.socket.emit('unsubscribe', _this.username)
        _this.socket.emit('subscribe', _this.username)
      })
      _this.socket.on('disconnect', function () {
        _this.ready = false
        debug('Disconnected from wallet')
      })
      _this.socket.on('connect_error', function (err) {
        debug('Connection error', err, err.stack)
      })
      _this.socket.on('payment', _this._handleNotification.bind(_this))
    })
    .catch(function (err) {
      debug(err)
    })
}

WalletClient.prototype.disconnect = function () {
  this.socket.emit('unsubscribe', this.username)
}

WalletClient.prototype.sendPayment = function (params) {
  params.sourceAccount = this.account
  params.sourcePassword = this.password
  debug('sendPayment', params)
  if (this.ready) {
    return sendPayment(params)
  } else {
    return new Promise(function (resolve, reject) {
      this.once('ready', resolve)
    })
    .then(function () {
      return sendPayment(params)
    })
  }
}

WalletClient.prototype._handleNotification = function (payment) {
  const _this = this
  if (payment.transfers) {
    debug('got notification of transfer' + payment.transfers)
    request.get(payment.transfers)
      .end(function (err, res) {
        if (err) {
          debug('Error getting transfer', err)
          return
        }
        const transfer = res.body
        if (transfer.state === 'executed') {
          // Look for incoming credits or outgoing debits involving us
          for (let credit of transfer.credits) {
            if (credit.account === _this.account) {
              _this.emit('incoming', credit)
            }
          }
        }
        if (transfer.state === 'rejected') {
          // TODO use notification of outgoing payments being rejected to subtract from amount sent to peer
          for (let debit of transfer.debits) {
            if (debit.account === _this.account) {
              _this.emit('outgoing_rejected', debit)
            }
          }
        }
      })
  }
}

// Returns a promise that resolves to the account details
function webfingerAddress (address) {
  const webfinger = new WebFinger()
  return new Promise(function (resolve, reject) {
    webfinger.lookup(address, function (err, res) {
      if (err) {
        return reject(new Error('Error looking up wallet address: ' + err.message))
      }

      try {
        for (let link of res.object.links) {
          if (link.rel === 'http://webfinger.net/rel/ledgerAccount') {
            // TODO also get the wallet API endpoint
            return resolve(link.href)
          }
        }
        return reject(new Error('Error parsing webfinger response' + JSON.stringify(res)))
      } catch (err) {
        return reject(new Error('Error parsing webfinger response' + err.message))
      }
    })
  })
}

exports.WalletClient = WalletClient
