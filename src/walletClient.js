'use strict'

const socket = require('socket.io-client')
const EventEmitter = require('events').EventEmitter
const inherits = require('inherits')
const sendPayment = require('five-bells-sender')
const request = require('superagent')
const WebFinger = require('webfinger.js')

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
}

inherits(WalletClient, EventEmitter)

WalletClient.prototype.connect = function () {
  const _this = this

  console.log('Account address:', this.address)
  return webfingerAddress(this.address)
    .then(function (account) {
      _this.account = account

      console.log('Attempting to connect to wallet: ' + _this.walletUri + '/api/socket.io')
      _this.socket = socket(_this.walletUri, { path: '/api/socket.io' })
      _this.socket.emit('subscribe', _this.username)
      _this.socket.on('connect', function () {
        console.log('Connected to wallet API socket.io')
        _this.emit('ready')
      })
      _this.socket.on('disconnect', function () {
        console.log('Disconnected from wallet')
      })
      _this.socket.on('connect_error', function (err) {
        console.log('Connection error', err, err.stack)
      })
      _this.socket.on('payment', _this._handleNotification.bind(_this))
    })
    .catch(function (err) {
      console.log(err)
    })
}

WalletClient.prototype.disconnect = function () {
  this.socket.emit('unsubscribe', this.username)
}

WalletClient.prototype.sendPayment = function (params) {
  params.sourceAccount = this.account
  params.sourcePassword = this.password
  console.log('sendPayment', params)
  return sendPayment(params)
    .then(function (result) {
      console.log('Sent payment: ', result)
    })
    .catch(function (err) {
      console.log('Error sending payment: ', (err && err.response && err.response.body ? err.response.body : err))
    })
}

WalletClient.prototype._handleNotification = function (payment) {
  const _this = this
  if (payment.destination_account === _this.account) {
    if (payment.transfers) {
      request.get(payment.transfers)
        .end(function (err, res) {
          if (err) {
            console.log('Error getting transfer', err)
            return
          }
          const transfer = res.body
          for (let credit of transfer.credits) {
            if (credit.account === _this.account) {
              _this.emit('incomingCredit', credit)
            }
          }
        })
    }
  } else if (payment.source_account === this.account) {
    console.log(payment)
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
