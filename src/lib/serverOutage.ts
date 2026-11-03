import { create } from "zustand";

/** True while the server has stayed unreachable past a brief blip. LocalAccess keeps this current. */
export const useServerOutage = create(() => ({ outage: false }));
