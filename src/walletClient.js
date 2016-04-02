'use strict'

import socket from 'socket.io-client'
import { EventEmitter } from 'events'
import sendPayment, { findPath } from 'five-bells-sender'
import request from 'superagent'
import WebFinger from 'webfinger.js'
import Debug from 'debug'
const debug = Debug('WebTorrentIlp:WalletClient')

/**
 * Client for connecting to the five-bells-wallet
 * @param {String} opts.address
 * @param {String} opts.password
 */
export default class WalletClient extends EventEmitter {
  constructor (opts) {
    super()

    this.address = opts.address
    this.password = opts.password
    this.account = null

    // TODO these should be removed once the wallet returns the right values from webfinger
    this.walletUri = 'https://' + opts.address.split('@')[1]
    this.username = opts.address.split('@')[0]

    this.socket = null
    this.ready = false
  }

  connect () {
    debug('Account address:', this.address)
    return WalletClient.webfingerAddress(this.address)
      .then((account) => {
        this.account = account

        debug('Attempting to connect to wallet: ' + this.walletUri + '/api/socket.io')
        this.socket = socket(this.walletUri, { path: '/api/socket.io' })
        this.socket.on('connect', () => {
          debug('Connected to wallet API socket.io')
          this.ready = true
          this.emit('ready')
          this.socket.emit('unsubscribe', this.username)
          this.socket.emit('subscribe', this.username)
        })
        this.socket.on('disconnect', () => {
          this.ready = false
          debug('Disconnected from wallet')
        })
        this.socket.on('connect_error', (err) => {
          debug('Connection error', err, err.stack)
        })
        this.socket.on('payment', this._handleNotification.bind(this))
      })
      .catch((err) => {
        debug(err)
      })
  }

  disconnect () {
    this.socket.emit('unsubscribe', this.username)
  }

  normalizeAmount (params) {
    // TODO cache rate so we don't have to do a pathfind every time
    return findPath({
      ...params,
      sourceAccount: this.account
    })
    .then((path) => {
      if (Array.isArray(path) && path.length > 0) {
        // TODO update this for the latest sender
        const firstPayment = path[0]
        const sourceAmount = firstPayment.source_transfers[0].debits[0].amount
        debug(params.destinationAmount + ' on ' + path[path.length - 1].destination_transfers[0].ledger +
          ' is equivalent to ' + sourceAmount + ' on ' + firstPayment.source_transfers[0].ledger)
        return sourceAmount
      } else {
        throw new Error('No path found %o', path)
      }
    })
    .catch((err) => {
      debug('Error finding path %o %o', params, err)
      throw err
    })
  }

  sendPayment (params) {
    const paramsToSend = {
      ...params,
      sourceAccount: this.account,
      sourcePassword: this.password
    }
    debug('sendPayment', paramsToSend)
    if (this.ready) {
      return sendPayment(paramsToSend)
    } else {
      return new Promise((resolve, reject) => {
        this.once('ready', resolve)
      })
        .then(() => {
          return sendPayment(paramsToSend)
        })
    }
  }

  _handleNotification (payment) {
    if (payment.transfers) {
      request.get(payment.transfers)
        .end((err, res) => {
          if (err) {
            debug('Error getting transfer', err)
            return
          }
          const transfer = res.body
          debug('got notification of transfer ' + payment.transfers, transfer)
          if (transfer.state === 'executed') {
            // Look for incoming credits or outgoing debits involving us
            for (let credit of transfer.credits) {
              if (credit.account === this.account) {
                this.emit('incoming', credit)
              }
            }
          }
          if (transfer.state === 'rejected') {
            // TODO use notification of outgoing payments being rejected to subtract from amount sent to peer
            for (let debit of transfer.debits) {
              if (debit.account === this.account) {
                this.emit('outgoing_rejected', debit)
              }
            }
          }
        })
    }
  }

  // Returns a promise that resolves to the account details
  static webfingerAddress (address) {
    const WebFingerConstructor = (window && typeof WebFinger !== 'function' ? window.WebFinger : WebFinger)
    const webfinger = new WebFingerConstructor()
    return new Promise((resolve, reject) => {
      webfinger.lookup(address, (err, res) => {
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
}
