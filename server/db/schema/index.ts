import { authSchema } from "./auth-schema";
import { hostedFile } from "./hosted-file";
import { userProfile } from "./profile";
import { subscriptionMembership } from "./subscription-membership";

export { authSchema, hostedFile, subscriptionMembership, userProfile };

export const databaseSchema = {
  ...authSchema,
  hostedFile,
  subscriptionMembership,
  userProfile,
};
