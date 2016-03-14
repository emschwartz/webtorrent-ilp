'use strict'

const socket = require('socket.io-client')
const EventEmitter = require('events').EventEmitter
const inherits = require('inherits')
const sendPayment = require('five-bells-sender')
const request = require('superagent')

/**
 * Client for connecting to the five-bells-wallet
 * @param {String} opts.walletUri
 * @param {String} opts.username
 * @param {String} opts.password
 */
function PaymentManager (opts) {
  EventEmitter.call(this)

  this.walletUri = opts.walletUri
  this.account = this.walletUri + '/ledger/accounts/' + opts.username
  this.username = opts.username
  this.password = opts.password
  this.socket = null
}

inherits(PaymentManager, EventEmitter)

PaymentManager.prototype.connect = function () {
  const _this = this
  console.log('Attempting to connect to wallet: ' + this.walletUri + '/socket.io')
  this.socket = socket(this.walletUri, { path: '/api/socket.io' })
  this.socket.emit('unsubscribe', _this.username)
  this.socket.emit('subscribe', _this.username)
  this.socket.on('connect', function () {
    console.log('Connected to wallet API socket.io')
  })
  this.socket.on('disconnect', function () {
    console.log('Disconnected from wallet')
  })
  this.socket.on('connect_error', function (err) {
    console.log('Connection error', err, err.stack)
  })
  this.socket.on('payment', function (payment) {
    if (payment.transfers) {
      request.get(payment.transfers)
        .end(function (err, res) {
          if (err) {
            console.log('Error getting transfer', err)
            return
          }
          _this.emit('incoming', res.body)
        })
    }
  })
}

PaymentManager.prototype.disconnect = function () {
  this.socket.emit('unsubscribe', this.username)
}

PaymentManager.prototype.sendPayment = function (params) {
  params.sourceAccount = this.account
  params.sourcePassword = this.password
  sendPayment(params)
    .then(function (result) {
      console.log('Sent payment: ', result)
    })
    .catch(function (err) {
      console.log('Error sending payment: ', (err && err.response && err.response.body ? err.response.body : err))
    })
}

exports.PaymentManager = PaymentManager
