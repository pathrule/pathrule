// SPDX-License-Identifier: Apache-2.0
/**
 * The provider name the native account records its person under (core storage/account-owners.ts),
 * which is what the hook reads. Its own module so the credential lifecycle, which the CLI's logout
 * reaches, does not pull the account composition into the CLI bundle.
 */
export const NATIVE_ACCOUNT_PROVIDER = "native";
