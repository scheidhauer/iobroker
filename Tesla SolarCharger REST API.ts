const url = "http://raspberrypi:7190/api/Config/GetSettings";

const STATE_PREFIX = "javascript.0.tesla.";

class TeslaState {
    public readonly iobState: string;
    public readonly valueGetter: (car:any) => string;


    constructor(iobState: string, valueGetter: (car:any) => string) {
        this.iobState = iobState;
        this.valueGetter = valueGetter;
    }

    public getValue(car: any): string {
        return this.valueGetter(car);
    }

    public updateState(car: any): void {
        const fullState = STATE_PREFIX + this.iobState;
        let value = this.getValue(car);
        if (getState(fullState).val == value) {
            return;
        }

        setState(fullState, value, true);
        //console.log("Wert gespeichert: " + fullState + ", " + value);
    }

}


const states: TeslaState[] = [
    new TeslaState("soc", (car) => car.soC.value),
    new TeslaState("chargingPowerAtHome", (car) => car.chargingPowerAtHome),
    new TeslaState("minBatteryTemperature", (car) => car.minBatteryTemperature.value),
    new TeslaState("maxBatteryTemperature", (car) => car.maxBatteryTemperature.value)
];

for (const state of states) {
    createState(STATE_PREFIX + state.iobState);
}

function refreshTeslaData() {
    httpGet(url, { timeout: 2000 }, (err, response) => {
        if (err) {
            console.error(err);
            return;
        }
        
        let data;
        try {
            data = JSON.parse(response.data);

        } catch (e) {
            console.error("Fehler beim Parsen der Antwort: " + e);
            return;
        }

        let car = data?.cars?.[0];
        if (car) {
            for (const state of states) {
                state.updateState(car);
            }
        } else {
            console.log("Erwartetes Feld 'wert' nicht gefunden");
        }
    });
}

setInterval(refreshTeslaData, 10000);
