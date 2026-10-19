// The limiter slot: a module's declared limits held across the calls it makes
// (`limitRequest`, then `limited` around the call), the slot a host fills
// (`installLimiter`), and the in-process limiter a host starts from.

export * from '../services/limiter/limiter';
