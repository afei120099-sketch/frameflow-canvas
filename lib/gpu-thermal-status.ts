export type ThermalStatus = {
  temperatureC: number | null;
  latched: boolean;
  blocked: boolean;
  canResume: boolean;
  reason: string;
  stopConfirmed: boolean;
};
