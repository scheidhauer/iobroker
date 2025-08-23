////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// wrapper methods for access to IOBroker API, thus we have no errors 
// about missing methods in VS Code here
////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function getStateIOB(id: string)  {
    // @ts-ignore
    return getState(id);
}

function setStateIOB(id: string, state: any, ack?:boolean): void  {
    if (ack == undefined) {
        // @ts-ignore
        setState(id, state);
    } else {
        // @ts-ignore
        setState(id, state, ack);
    }
}

function createStateIOB(id: string)  {
    // @ts-ignore
    return createState(id);
}

function onIOB(options: { id: string | string[]; change: string; }, handler: () => void) {
    // @ts-ignore
    on(options, handler);
}

function getObjectIOB(id: string): any {
    // @ts-ignore
    return getObject(id);
}

function scheduleIOB(pattern: string, callback: () => void) {
    // @ts-ignore
    schedule(pattern, callback);
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////


function getValue(id: string)  {
    return getStateIOB(id).val;
}

function setStateClever(id: string, value, ack: boolean): void {
    var curVal = getValue(id);
    if (curVal != value) {
        setStateIOB(id, value, ack);
    }
}

var eigenverbrauch = "0_userdata.0.PV.Eigenverbrauch";

var pvErzeugung      = "alias.0.PV.PVErzeugung";
var currentPower     = "alias.0.PV.Einspeisung/Verbrauch";

var einspeisungTotal = "statistics.0.temp.sumDelta.alias.0.PV.EinspeisungTotal.day";
var bezugTotal = "statistics.0.temp.sumDelta.alias.0.PV.VerbrauchTotal.day";
var erzeugungHeute = "alias.0.PV.PV Ertrag Heute";

var eigenverbrauchTotalHeute = "0_userdata.0.PV.EigenverbrauchTotalHeute";
createStateIOB(eigenverbrauchTotalHeute);

var autarkie = "0_userdata.0.PV.Autarkie";
createStateIOB(autarkie);

function adaptEigenverbrauchHeute()  {
    var erz: number = getValue(erzeugungHeute);

    // erz abzgl. Stand am 13.2.2024 (wegen Zählerwechsel)
    //erz = erz - 405.022;

    var bezug: number = 1000 * getValue(bezugTotal);

    var einspeisung: number = 1000 * getValue(einspeisungTotal);

    var verbrauch: number = Math.round(erz + bezug - einspeisung);

    var aut: number = verbrauch<=0 ? 100 : Math.round(((erz-einspeisung)/verbrauch)*100) ;
    //console.warn("erz: " + erz + ", einspeisung: " + einspeisung + ", bezug: " + bezug + ", verbrauch: " + verbrauch + ", aut: " + aut);
    setStateClever(eigenverbrauchTotalHeute, verbrauch, true); // ack=true whichtig, damit der statistics adapter die Werte logged
    setStateClever(autarkie, aut, true);
}

adaptEigenverbrauchHeute();

onIOB({ id: [ pvErzeugung, currentPower ], change: 'ne'}, adaptEigenverbrauch);

onIOB({ id: [ einspeisungTotal, bezugTotal, erzeugungHeute ], change: 'ne'}, adaptEigenverbrauchHeute);


////////////////////////////////////////////////////////////////////////////////////////////////

var teslaChargePower = "0_userdata.0.PV.TeslaChargePower";

var teslaChargerActualCurrent = "tesla-motors.0.LRW3E7FS6PC834425.charge_state.charger_actual_current";
var teslaChargeCurrentRequested = "tesla-motors.0.LRW3E7FS6PC834425.charge_state.charge_current_request";
var teslaChargerVoltage = "tesla-motors.0.LRW3E7FS6PC834425.charge_state.charger_voltage";
var teslaChargerPhases = "tesla-motors.0.LRW3E7FS6PC834425.charge_state.charger_phases";

function adaptTeslaChargePower() {
    var voltage = getValue(teslaChargerVoltage);
    var phases = getValue(teslaChargerPhases);

    // see also https://github.com/pkuehnel/TeslaSolarCharger/blob/d0baa36136d7ba8d1d8ffbb7e8152e3f6fe902ca/TeslaSolarCharger/Shared/Dtos/Settings/CarState.cs#L34
    var actualPhases = phases > 1 ? 3 : 1;

    var actCurrent = getCurrentToUse();

    var power = actCurrent * voltage * actualPhases;

    //log("power: " + power + ", actCurrent: " + actCurrent + ", voltage: " + voltage + ", actualPhases: " + actualPhases);
    
    setStateIOB(teslaChargePower, power);
}


// see https://github.com/pkuehnel/TeslaSolarCharger/blob/d0baa36136d7ba8d1d8ffbb7e8152e3f6fe902ca/TeslaSolarCharger/Shared/Dtos/Settings/CarState.cs#L34
// method "ChargingPower"
function getCurrentToUse() {
    var actCurrent = getValue(teslaChargerActualCurrent);
    var reqCurrent = getValue(teslaChargeCurrentRequested);

    if (reqCurrent < 5 && actCurrent == reqCurrent + 1) {
        return (actCurrent + reqCurrent) / 2;
    } else {
        return actCurrent;
    }
}


adaptTeslaChargePower();

onIOB({ id: [ teslaChargerActualCurrent, teslaChargerVoltage, teslaChargerPhases ], change: 'ne'}, adaptTeslaChargePower);


///////////////////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////
/// ZENDURE
///////////////////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////

const MAX_POWER = 1200;
const AC_MODE_ID = "control.acMode";
const POWER_ID: string = "alias.0.PV.Einspeisung/Verbrauch";

// wenn gewünschte Lade- oder Entlade-Leistung kleiner diesem Wert, dann wird nur ein Hyper benutzt
const MIN_DISTRIBUTE_POWER = 1000;
// wenn nur ein Hyper gerade benutzt wird: dann darf dessen aktuelle Kapazität 500 Wh vom am besten geeigneten Hyper abweichen
const PREFER_HYPER_MAX_DIFFERENCE = 500;

const SECS_BETWEEN_MODE_SWITCH = 3*60; // mindestens 3 min zwischen mode switches

// when the change between old and new power ist below this value, we will ignore it in oder not to send too many commands to the akku
const MIN_POWER_CHANGE = 30;

enum AcMode {
    AC_MODE_AUS = 0,
    AC_MODE_LADEN = 1,
    AC_MODE_EINSPEISEN = 2
}

class Hyper {

    private static readonly ALL_HYPERS : Hyper[] = [ 
            new Hyper("zendure-solarflow.0.gDa3tb.dT4s7652"),
            new Hyper("zendure-solarflow.0.gDa3tb.0261mkBX") 
        ];


    private readonly id: string;   
    private timeOfLastModeSwitch: Date = new Date(0);
    private warnWhenControllOff: boolean = true;
    private firstTimeWhenOutputWasZero: Date|null = null;


    static getAllHypers(): Hyper[] {
        return Hyper.ALL_HYPERS;
    }

    constructor(id: string) {
        this.id = id;
    }
 
    private setDeviceAutomationInOutLimit(val): void {

        this.logDebug(": setDeviceAutomationInOutLimit: " + val);

        if (this.noNeedToChangePower(val)) {
            this.logDebug(": noNeedToChangePower: new: " + val + ", old: " + this.getPower());
            return;
        }

        //this.setValue("control.setDeviceAutomationInOutLimit", val);


        if (val >= 0) {
            this.setValue("control.setOutputLimit", val);
        }

        if (val <= 0) {
            this.setValue("control.setInputLimit", -val);
        }
    }

    private noNeedToChangePower(newPower: number): boolean {
        var curPower = this.getPower();

        if (curPower == newPower) {
            return true;
        }

        if (newPower == 0 || Math.sign(curPower) != Math.sign(newPower)) {
            return false;
        }

        if (Math.abs(Math.abs(curPower) - Math.abs(newPower)) < MIN_POWER_CHANGE) {
            return true;
        } 

        return false;
    }

    
    setChargeLimit(val): void {
        this.setValue("control.chargeLimit", val);
    }

    private getValue(value: string) {
        return getValue(this.id + "." + value)
    }

    private setValue(id: string, val) {
        setStateIOB(this.id + "." + id, val);
    }

    getPower(): number {
        return this.getValue("gridInputPower") - this.getOutputHomePower();
    }

    getOutputHomePower(): number {
        return this.getValue("outputHomePower");
    }

    getSOC(): number {
        return this.getValue("electricLevel");
    }

    getTotalCapacity(): number {
        var numBatteries = this.getValue("packNum");
        return numBatteries * 1920;
    }

    getCurrentCapacity(): number {
        return Math.round(this.getTotalCapacity() * this.getSOC() / 100);
    }

    getName(): string {
        var thisHyper = getObjectIOB(this.id);
        var name:string = thisHyper.common.name.de;
        return name.replace(/ \(.*\)/, ""); // ID rausnehmen
    }


    deactivate(): void {
        this.setAcValue(0);
    }

    logDebug(msg: string): void {
        console.debug(this.getName() + msg);
    }

    getPowerWhenNotControlled(): number {
        return getValue("0_userdata.0.PV.AkkuPower-" + this.getGUID());
    }

    isControlled(): boolean {
        return getValue("0_userdata.0.PV.AkkuSteuerung-" + this.getGUID()) == true;
    }

    getDischargeLimit(): number {
        return this.getValue("minSoc");
    }

    getChargeLimit(): number {
        return this.getValue("socSet");
    }

    isBelowDischargeLimit(): boolean {
        return this.getSOC() < this.getDischargeLimit();
    }

    checkBelowDischargeLimit(desiredPower: number): boolean {
        if (desiredPower > 0 && this.isBelowDischargeLimit()) {
            this.logDebug(" is below discharge limit (" + this.getSOC() + "% < " + this.getDischargeLimit() + "%), charging now");
            this.setAcValue(-500);
            return false;
        }

        return true;
    }

    isAvailable(desiredPower: number): boolean {
        if (! this.isControlled()) {
            if (this.warnWhenControllOff) {
                console.warn(this.getName() + " Akkusteuerung aus");
                this.warnWhenControllOff = false;
            }

            // hmpf: -1 weil getPower() und setAcValue() sind sich wohl nicht einig, was das Vorzeichen angeht
            var power = -1 * this.getPowerWhenNotControlled();
            var curPower = this.getPower();
            if (Math.abs(power - curPower) > 5) {  // > 5 weil das Setzen mitunter nicht genau aufs Watt funktioniert
                console.info("change power of " + this.getGUID() + " to: " + power + " (before: " + curPower + ")");
                this.setAcValue(power);
            }
            return false;
        }

        this.warnWhenControllOff = true;

        const MIN_POWER = 50 * Hyper.getAllHypers().length;
        if (Math.abs(desiredPower) <= MIN_POWER) {
            this.logDebug(" aus, da realeLeistung==" + desiredPower);
            this.setAcValue(0);
            return false;
        }

        var chargeLimit = this.getChargeLimit();
        var dischargeLimit = this.getDischargeLimit();
        var soc = this.getSOC();

        if (desiredPower < 0 && soc >= chargeLimit) {
            this.logDebug(": Akku voll");
            this.setAcValue(0);
            return false;
        } 

        if (desiredPower > 0) {
            if (soc <= dischargeLimit) {
                this.logDebug(": Akku leer");
                this.setAcValue(0);
                return false;
            }

            // es kannn passieren, dass der Akku nicht mehr entladen werden kann,
            // obwohl das Entladelimit noch nicht erreicht wurde
            if (soc <= 15) { // damit wir sicher nicht zu früh abschalten
                if (this.getOutputHomePower() == 0) {
                    if (this.firstTimeWhenOutputWasZero == null) {
                        this.firstTimeWhenOutputWasZero = new Date();
                    }

                    this.logDebug(" checking for discharge limit reached: " + this.firstTimeWhenOutputWasZero);

                    var now = new Date();
                    if (now.getTime() - this.firstTimeWhenOutputWasZero.getTime() > 60 * 1000) {
                        this.logDebug(" kann wohl nicht mehr weiter entladen werden.");
                        return false;
                    }
                } else {
                    // this.logDebug(" reset discharge limit 1");
                    this.firstTimeWhenOutputWasZero = null;
                }
            }
       } else {
            // this.logDebug(" reset discharge limit 2");
            this.firstTimeWhenOutputWasZero = null;
       }
        
        // Umschaltung zwischen Laden und Entladen stresst wohl die Hardware, daher machen wir das nicht zu oft
        if (! this.checkModeSwitch(desiredPower)) {
            this.logDebug(": Kein mode switch, warte noch " + (SECS_BETWEEN_MODE_SWITCH - this.getSecsSinceLastModeChange()) + " Sekunden.");
            this.setDeviceAutomationInOutLimit(0);
            return false;
        }

        return true;
    }

    private getGUID(): string {
        return this.id.substring(this.id.lastIndexOf(".") + 1)
    }

    setAcValue(power: number): void  {
        this.logDebug(": setAcValue: " + power);

        if (power == 0) {
            //this.logDebug(" reset discharge limit 3");

            this.firstTimeWhenOutputWasZero = null;
            this.setDeviceAutomationInOutLimit(0);
        } else {
            power = Math.min(MAX_POWER, power);
            power = Math.max(-MAX_POWER, power);
            this.setDeviceAutomationInOutLimit(power);
        }

        this.setAcMode(power);        
    }

    private toAcMode(power: number): AcMode  {
        return (power >= 0) ? AcMode.AC_MODE_EINSPEISEN : AcMode.AC_MODE_LADEN;
    }

    private getAcMode(): number  {
        return this.getValue(AC_MODE_ID);
    }

    private setAcMode(power: number): void  {
        var newMode = this.toAcMode(power);
        var oldMode = this.getAcMode();
        if (oldMode == newMode || power == 0 ) {
            return;
        }

        this.timeOfLastModeSwitch = new Date();
        this.logDebug(": mode switch: " + oldMode + " --> " + newMode);
        this.setValue(AC_MODE_ID, newMode);
    }

    private checkModeSwitch(power: number): boolean {
        var newAcMode = this.toAcMode(power);
        return (newAcMode == this.getAcMode()) ||
               (this.getSecsSinceLastModeChange() > SECS_BETWEEN_MODE_SWITCH);
    }

    private getSecsSinceLastModeChange(): number {
        var now = new Date().getTime();
        return Math.round((now - this.timeOfLastModeSwitch.getTime()) / 1000);
    }
}

function getCurrentZendurePower(includeNotControlledHypers: boolean): number {
    var ret: number = 0;
    for (var hyper of Hyper.getAllHypers()) {
        if (includeNotControlledHypers || hyper.isControlled()) {
            ret += hyper.getPower();
        }
    }

    return ret;
}

function getBatteryTotalSOC(): number {
    var totalMaxCapacity = 0;
    var totalCurCapacity = 0;
    for (var hyper of Hyper.getAllHypers()) {
        var soc = hyper.getSOC();
        var capacity = hyper.getTotalCapacity();
        totalMaxCapacity += capacity;
        totalCurCapacity += (capacity * soc) / 100;
    }

    // benutze floor() weil: wenn ein Akku 99% und einer 100% hat, soll das nicht als 100% reported werden
    return Math.floor((totalCurCapacity / totalMaxCapacity) * 100);
}

function adaptEigenverbrauch()  {
    var erz: number = getValue(pvErzeugung);
    var power: number = getValue(currentPower);
    var akkuPower: number = getCurrentZendurePower(true);

    var verbrauch: number = (erz + power - akkuPower);
    //log("Verbrauch: " + verbrauch);
    setStateIOB(eigenverbrauch, verbrauch);
}

adaptEigenverbrauch();


var lastChoosenHyper: Hyper | null = null;

function adaptZendure()  {
    var curTotalPower = getCurrentZendurePower(true);
    var totalSOC = getBatteryTotalSOC();

    setStateClever("0_userdata.0.PV.AkkuLeistung", curTotalPower, true);
    setStateClever("0_userdata.0.PV.AkkuTotalSOC", totalSOC, true);

    var curControlledPower = getCurrentZendurePower(false);
    var curLeistung = getValue(POWER_ID);
    var desiredPower = curLeistung - curControlledPower;

    if (desiredPower != 0) {
        // Wenn wir Strom aus dem Netz ziehen: lieber den Akku anweisen etwas mehr abzugeben, 
        // als evtl. doch noch ein klein bisschen was aus dem Netz zu ziehen
        // Umgekehrt gilt das auch, wenn wir einspeisen: lieber den Akku mit etwas weniger laden.
        desiredPower += 5;
    }

    var availableHypers: Hyper[] = [];
    for (var hyper of Hyper.getAllHypers()) {
        if (hyper.checkBelowDischargeLimit(desiredPower) && hyper.isAvailable(desiredPower)) {
            availableHypers.push(hyper);
        }
    }

    if (availableHypers.length > 0 && Math.abs(desiredPower) < MIN_DISTRIBUTE_POWER) {
        lastChoosenHyper = getHyperWithHighestOrLowestCapacity(availableHypers, desiredPower);

        // alle anderen abschalten
        for (var hyper of availableHypers) {
            if (lastChoosenHyper !== hyper) {
                hyper.deactivate();
            }
        }        

        availableHypers = [lastChoosenHyper];
        
        console.debug("desired power low: choosing only one hyper: " + lastChoosenHyper.getName());
    } else {
        lastChoosenHyper = null;
    }

    for (var hyper of availableHypers) {
        var desiredPowerPerHyper = Math.round(desiredPower / availableHypers.length);
        hyper.setAcValue(desiredPowerPerHyper);
    }
}

function getHyperWithHighestOrLowestCapacity(availableHypers: Hyper[], desiredPower: number): Hyper {
    var hypersSorted: Hyper[] = availableHypers.sort((h1, h2) => h2.getCurrentCapacity() - h1.getCurrentCapacity());
    var hyperWithHighestCapacity = desiredPower > 0 ? hypersSorted[0] : hypersSorted[hypersSorted.length-1];

    // wir wollen nicht zu oft zwischen den Hypern hin- und herschalten
    if (lastChoosenHyper != null && 
        hyperWithHighestCapacity !== lastChoosenHyper && 
        Math.abs(hyperWithHighestCapacity.getCurrentCapacity() - lastChoosenHyper.getCurrentCapacity()) < PREFER_HYPER_MAX_DIFFERENCE) {

        console.debug("prefering hyper: " + hyperWithHighestCapacity.getName());
        
        return lastChoosenHyper;
    }

    return hyperWithHighestCapacity;
}

onIOB({ id: POWER_ID, change: 'ne'}, adaptZendure);
//adaptZendure();


function setChargeLimitAllHypers(val: number): void {
    console.info('*** Alle Hypers auf ' + val + '%');
    for (var hyper of Hyper.getAllHypers()) {
        hyper.setChargeLimit(val);
    }
}

// Alle Hypers ein mal die Woche auf 100% laden (wenn genug Sonne kommt :-)
//schedule( {hour: 1, minute: 0, dayOfWeek: 6}, function() {

// Samstag 5 Uhr auf 100%
scheduleIOB( '0 5 * * 6', () => setChargeLimitAllHypers(100));

// Sonntag 5 Uhr wieder zurück auf 90%
scheduleIOB('0 5 * * 0', () => setChargeLimitAllHypers(90));
