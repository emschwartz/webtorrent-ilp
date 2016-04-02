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

  recordFailedPayment (payment, err) {
    debug('recordFailedPayment %o Error: %o', payment, err)
    // TODO remove payment (note that this means we need to use a deterministic id or use a search)
    return Promise.resolve()
  }

  recordDelivery (delivery) {
    debug('recordDelivery %o', delivery)
    return Promise.resolve(this.Delivery.inject(delivery))
  }

  getTotalSent (filters) {
    const payments = this.Payment.filter(filters)
    let total = new BigNumber(0)
    for (let payment of payments) {
      total = total.plus(payment.sourceAmount)
    }
    return Promise.resolve(total)
  }
}
