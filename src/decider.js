import Debug from 'debug'
const debug = Debug('WebTorrentIlp:Decider')
import JSData from 'js-data'
import uuid from 'uuid'
import BigNumber from 'bignumber.js'

export default class Decider {
  constructor (opts) {
    this.store = new JSData.DS()
    // TODO don't use uuids, maybe use incrementing numbers to reduce memory
    this.Payment = this.store.defineResource({
      name: 'payment',
      computed: {
        id: ['id', (id) => id || uuid.v4()]
      }
    })
    this.PaymentRequest = this.store.defineResource({
      name: 'payment_request',
      computed: {
        id: ['id', (id) => id || uuid.v4()]
      }
    })
    this.Delivery = this.store.defineResource({
      name: 'delivery',
      computed: {
        id: ['id', (id) => id || uuid.v4()]
      }
    })
  }

  shouldSendPayment (paymentRequest) {
    return this.recordPaymentRequest(paymentRequest)
      .then(() => {
        // TODO @tomorrow put checking logic here
        const costPerByte = this.getCostPerByte({
          publicKey: paymentRequest.publicKey,
          torrentHash: paymentRequest.torrentHash
        })
        debug('checking if we shouldSendPayment, costPerByte: ' + costPerByte.toString())

        if (!costPerByte.isFinite()) {
          return false
        }

        return true
      })
  }

  recordPaymentRequest (paymentRequest) {
    debug('Got payment request %o', paymentRequest)
    return Promise.resolve(this.PaymentRequest.inject(paymentRequest))
  }

  recordPayment (payment) {
    debug('recordPayment %o', payment)
    return Promise.resolve(this.Payment.inject(payment))
  }

  recordFailedPayment (paymentId, err) {
    debug('recordFailedPayment %o Error: %o', paymentId, err)
    return Promise.resolve(this.Payment.eject(paymentId))
  }

  recordDelivery (delivery) {
    debug('recordDelivery %o', delivery)
    return Promise.resolve(this.Delivery.inject(delivery))
  }

  getTotalSent (filters) {
    const payments = this.Payment.filter(filters)
    return sum(payments, 'sourceAmount')
  }

  getBytesDelivered (filters) {
    const deliveries = this.Delivery.filter(filters)
    return sum(deliveries, 'bytes')
  }

  getCostPerByte (filters) {
    const totalSent = this.getTotalSent(filters)
    const bytesDelivered = this.getBytesDelivered(filters)
    if (totalSent.equals(0)) {
      return new BigNumber(0)
    }
    return totalSent.div(bytesDelivered)
  }
}

function sum (arr, key) {
  let total = new BigNumber(0)
  for (let item of arr) {
    total = total.plus(item[key])
  }
  return total
}
