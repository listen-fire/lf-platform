import { profilesExchange } from './queues/profiles';
import { usersExchange } from './queues/users';
import { triggerRunsExchange } from './queues/triggerRuns';
import { triggerRunActivityExchange } from './queues/triggerRunActivity';
import { resourceChangesExchange } from './queues/resourceChanges';

const mq = {
  resourceChanges: resourceChangesExchange,
  triggerRunActivity: triggerRunActivityExchange,
  profiles: profilesExchange,
  users: usersExchange,
  triggerRuns: triggerRunsExchange,
};

export { mq };
