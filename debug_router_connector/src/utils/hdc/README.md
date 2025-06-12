This is a pure nodejs client for [OpenHarmony HDC](https://github.com/waylau/harmonyos-tutorial/blob/master/README.md).

We just implement some necessary message:

* fport ls
* fprot rm
* list target -v
* fport

Read [hdc meessage protocol]([https://github.com/openharmony/developtools_hdc_standard](https://github.com/openharmony/developtools_hdc_standard)) for more meesage protocol if need.

Interface keep same with @devicefarmer/adbkit.

```typescript
import Hdc from "./hdc";

const client = Hdc.createClient();

// list target
const targets = await client.listTargets();

// get target
const device = client.getDevice(serial);

// fport 
const result = await device.forward(`tcp:${hostport}`, `tcp:${remotePort}`);

// fport list
const result = await device.listForwards();

// fport rm 
const result = await device.removeForward(forwards[i].local, forwards[i].remote);
```
