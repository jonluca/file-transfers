import { Redirect } from "expo-router";

export default function AuthCallbackScreen() {
  return <Redirect href={"/account"} />;
}
