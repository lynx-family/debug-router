export default interface Target {
  connectKey: string;
  connType: "TCP" | "USB" | "UART" | "BT" | "UNKNOW";
  connStatus: "Ready" | "Connected" | "Offline" | "UNKNOW";
  devName?: string;
}
