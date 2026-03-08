import { Redirect } from "expo-router";

export default function AccountRedirectScreen() {
  return <Redirect href={"/settings"} />;
}
