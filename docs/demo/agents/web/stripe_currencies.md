url: https://docs.stripe.com/currencies
title: Supported currencies | Stripe Documentation

## Zero-decimal currencies

All API requests expect amounts to be provided in a currency's smallest unit. For example, to charge 10 USD, provide an amount value of 1000 (that is, 1000 cents).

For zero-decimal currencies, still provide amounts as an integer but without multiplying by 100. For example, to charge ¥500, provide an amount value of 500.

The zero-decimal currencies: BIF, CLP, DJF, GNF, JPY, KMF, KRW, MGA, PYG, RWF, UGX, VND, VUV, XAF, XOF, XPF.

Currency codes in the API are lowercase (`usd`, `gbp`, `eur`).
