import { JsonRpcProvider } from "ethers/providers";
import { Networkish } from "ethers/utils";
import { ConnectionInfo, poll } from "ethers/utils/web";

export class RetryProvider extends JsonRpcProvider {
  public attempts: number;

  constructor(
    attempts: number,
    url?: ConnectionInfo | string,
    network?: Networkish
  ) {
    super(url, network);
    this.attempts = attempts;
  }

  public perform(method: string, params: any) {
    let attempts = 0;
    return poll(() => {
      attempts++;
      return super.perform(method, params).then(
        result => {
          return result;
        },
        (error: any) => {
          if (error.statusCode !== 429 || attempts >= this.attempts) {
            return Promise.reject(error);
          } else {
            return Promise.resolve(undefined);
          }
        }
      );
    });
  }
}