
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

function existsStateIOB(id: string): boolean {
    // @ts-ignore
    return existsState(id);
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
    private alertSent: boolean = false;


    static getAllHypers(): Hyper[] {
        return Hyper.ALL_HYPERS;
    }

    constructor(id: string) {
        this.id = id;
    }
 
    // Neue Klassen-Eigenschaften für das Tracking
    private lastSentValue: number = 0;
    private lastSentTime: number = 0;
    private readonly MIN_UPDATE_INTERVAL_MS = 30000; // 30 Sekunden
    private readonly MIN_CHANGE_WATTS = 30; // 30W Hysterese

    private setDeviceAutomationInOutLimit(val: number): void {

        // Bedeutung von val sollte sein
        //    negativer Wert --> Akku wird GEladen
        //    positiver Wert --> Akku wird ENTladen

        const curPower = this.getPower();

        if (this.noNeedToChangePower(val, curPower)) {
            this.logDebug(": noNeedToChangePower: new: " + val + ", old: " + curPower);
            return;
        }

        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastSentTime;
        const powerDifference = Math.abs(val - this.lastSentValue);

        // Drosselung: Ignoriere kleine Änderungen oder zu schnelle Updates, 
        // ES SEI DENN, es ist eine massive Änderung (z.B. > 500W wg. Herd/Backofen)
        if (timeSinceLastUpdate < this.MIN_UPDATE_INTERVAL_MS && powerDifference < 500) {
            // this.logDebug("Update verworfen (Rate-Limit). Differenz: " + powerDifference + "W");
            return;
        }

        if (powerDifference < this.MIN_CHANGE_WATTS) {
            // this.logDebug("Update verworfen (Hysterese). Differenz zu klein.");
            return;
        }

        // Wenn wir hier ankommen, dürfen wir senden
        this.logDebug(": setDeviceAutomationInOutLimit: " + val + " (alt: " + this.lastSentValue + ")");
        this.setValue("control.setDeviceAutomationInOutLimit", val);
        
        // Status aktualisieren
        this.lastSentValue = val;
        this.lastSentTime = now;
    }
    private noNeedToChangePower(newPower: number, curPower: number): boolean {

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
        return this.getOutputHomePower() - this.getValue("gridInputPower");
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
        return parseInt(getValue("0_userdata.0.PV.AkkuPower-" + this.getGUID()));
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

            var power = this.getPowerWhenNotControlled();
            var curPower = this.getPower();
            if (Math.abs(power - curPower) > 5) {  // > 5 weil das Setzen mitunter nicht genau aufs Watt funktioniert
                console.info("change power of " + this.getName() + " to: " + power + " (before: " + curPower + ")");
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

    getLastUpdate(): number {
        const val = this.getValue("lastUpdate");
        if (val === null || val === undefined) {
            return 0;
        }
        const time = new Date(val).getTime();
        return isNaN(time) ? 0 : time;
    }

    checkFailure(maxAgeMs: number, whatsAppId: string): void {
        const lastUpdateTime = this.getLastUpdate();
        if (lastUpdateTime === 0) {
            log(`Zendure-Überwachung: Letztes Update für ${this.getName()} konnte nicht gelesen werden.`, 'warn');
            return;
        }

        const diffMs = Date.now() - lastUpdateTime;

        if (diffMs > maxAgeMs) {
            if (!this.alertSent) {
                const minutesAgo = Math.round(diffMs / 1000 / 60);
                const message = `⚠️ *Zendure Alarm*: Der Akku *${this.getName()}* hängt vermutlich! Das letzte Update liegt bereits ${minutesAgo} Minuten zurück.`;
                
                if (existsStateIOB(whatsAppId)) {
                    setStateIOB(whatsAppId, message);
                } else {
                    log(`WhatsApp Datenpunkt ${whatsAppId} nicht gefunden!`, 'warn');
                }

                log(message, 'warn');
                this.alertSent = true;
            }
        } else {
            if (this.alertSent) {
                const recoveryMessage = `✅ *Zendure Entwarnung*: Der Akku *${this.getName()}* sendet wieder aktuelle Daten.`;
                
                if (existsStateIOB(whatsAppId)) {
                    setStateIOB(whatsAppId, recoveryMessage);
                }
                
                log(recoveryMessage, 'info');
                this.alertSent = false;
            }
        }
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

    var verbrauch: number = (erz + power + akkuPower);
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
    var desiredPower = curLeistung + curControlledPower;

    if (desiredPower != 0) {
        // Wenn wir Strom aus dem Netz ziehen: lieber den Akku anweisen etwas mehr abzugeben, 
        // als evtl. doch noch ein klein bisschen was aus dem Netz zu ziehen
        // Umgekehrt gilt das auch, wenn wir einspeisen: lieber den Akku mit etwas weniger laden.
        desiredPower += 5;
    }

    var availableHypers: Hyper[] = [];
    for (var hyper of Hyper.getAllHypers()) {
        // TODO: Aufruf von isAvailable() muss auf alle Fälle erfolgen, sonst wird das setAcValue() da drin nicht aufgerufen
        let available = hyper.isAvailable(desiredPower);
        if (hyper.checkBelowDischargeLimit(desiredPower) && available) {
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

const Sommer:boolean = true;

if (Sommer) {

    // Samstag 5 Uhr auf 100%
    scheduleIOB( '0 5 * * 6', () => setChargeLimitAllHypers(100));
    
    // Sonntag 5 Uhr wieder zurück auf 90%
    scheduleIOB('0 5 * * 0', () => setChargeLimitAllHypers(90));
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Energiefluss erweitert hängt sich manchmal auf: wir check seinen Status regelmäßig und starten ihn neu wenn nötig
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const adapterInstance = "energiefluss-erweitert.0";

// Interne ioBroker Pfade
const objPath = "system.adapter." + adapterInstance;
const alivePath = objPath + ".alive";

// Schedule: Prüft alle 5 Minuten
schedule("*/5 * * * *", function () {
    let isAlive = getState(alivePath).val;
    
    if (!isAlive) {
        log(`Adapter ${adapterInstance} läuft nicht (alive = false). Führe Neustart durch...`, "warn");
        restartAdapter();
    }
});

// Funktion zum Neustarten des Adapters
function restartAdapter() {
    // 1. Adapter stoppen (enabled: false)
    extendObject(objPath, {common: {enabled: false}}, function() {
        log(`Adapter ${adapterInstance} wurde gestoppt. Warte auf Neustart...`, "info");
        
        // 2. 5 Sekunden warten, damit der Prozess sauber beendet wird
        setTimeout(function() {
            // 3. Adapter wieder starten (enabled: true)
            extendObject(objPath, {common: {enabled: true}});
            log(`Adapter ${adapterInstance} wurde wieder gestartet.`, "info");
        }, 5000); 
    });
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TSC (Tesla Solar Charger) Ansteuerung
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const http = require('http');

const tscIp: string = 'ds725:7190'; 
const carId: number = 1;
const dpChargeMode: string = '0_userdata.0.TSC.AktuellerLademodus';

// 1. Datenpunkt anlegen
createState(dpChargeMode, 2, {
    name: 'TSC Aktueller Lademodus',
    type: 'number',
    role: 'value',
    read: true,
    write: true,
    states: { 0: 'Off', 1: 'Manual', 2: 'Auto', 3: 'Max Power' }
});

const [host, port] = tscIp.split(':');

// --- TEIL 1: LESEN (Vom TSC abrufen) ---
function updateTscStatus(): void {
    const url = `http://${tscIp}/api/Config/GetSettings`;
    http.get(url, (res: any) => {
        let rawData = '';
        res.on('data', (chunk: any) => rawData += chunk);
        res.on('end', () => {
            try {
                const data = JSON.parse(rawData);
                const car = data.cars.find((c: any) => c.id === carId);
                if (car && car.chargeModeV2 !== undefined) {
                    setState(dpChargeMode, car.chargeModeV2, true);
                }
            } catch (e) { /* Fehler beim Polling stumm ignorieren */ }
        });
    }).on('error', (err: any) => console.error('[TSC-Read] Fehler: ' + err.message));
}

// --- TEIL 2: SCHREIBEN (An neue TSC Home-API senden) ---
on({id: dpChargeMode, change: 'any', ack: false}, (obj) => {
    const newModeNum = obj.state.val;
    
    // Wir übersetzen die ioBroker-Zahl in den Text, den die URL erwartet
    let modeString = '';
    switch (newModeNum) {
        case 0: modeString = 'Off'; break;
        case 1: modeString = 'Manual'; break;
        case 2: modeString = 'Auto'; break; // Bei manchen Versionen heißt das intern 'PvAndMinSoc'
        case 3: modeString = 'MaxPower'; break;
        default: return;
    }

    console.log(`[TSC-Write] Trigger! Sende neuen Lademodus für K.I.T.T.: ${modeString}`);

    // Die von dir gefundene URL zusammenbauen
    const path = `/api/Home/UpdateCarChargeMode?carId=${carId}&chargeMode=${modeString}`;

    // Die meisten dieser APIs verlangen POST für Aktionen
    const options = {
        hostname: host,
        port: parseInt(port),
        path: path,
        method: 'POST', 
        headers: {
            'Content-Length': 0 // Wir senden keine Daten im Body, alles steht in der URL
        }
    };

    const req = http.request(options, (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[TSC-Write] ERFOLG! API antwortete mit Status ${res.statusCode}`);
            setState(dpChargeMode, newModeNum, true); // Wert in ioBroker grün/bestätigt schalten
        } else {
            console.error(`[TSC-Write] FEHLER! Status ${res.statusCode}.`);
            // Setzt den ioBroker-Wert nach 2 Sekunden auf den echten Wert des TSC zurück
            setTimeout(updateTscStatus, 2000); 
        }
    });

    req.on('error', (e: any) => console.error(`[TSC-Write] Netzwerkfehler: ${e.message}`));
    req.end();
});

// --- TEIL 3: ZEITPLAN (30 Sekunden) ---
schedule('*/30 * * * * *', updateTscStatus);
updateTscStatus();

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Der Akku hängt sich manchmal auf: ich will eine WhatApp bekommen, wenn das der Fall ist, damit ich was unternehmen kann.
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const ID_WHATSAPP    = 'whatsapp-cmb.1.sendMessage'; // Evtl. whatsapp-cmb.1.<Instanz>.sendMessage anpassen
const MAX_AGE_MS     = 2 * 60 * 60 * 1000; // 2 Stunden in Millisekunden

// Zeitplan: Läuft alle 15 Minuten (*/15 * * * *)
scheduleIOB("*/15 * * * *", () => {
    for (const hyper of Hyper.getAllHypers()) {
        hyper.checkFailure(MAX_AGE_MS, ID_WHATSAPP);
    }
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Luftentfeuchter: WhatsApp-Benachrichtigung bei vollem Wassertank
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Luftentfeuchter: WhatsApp-Benachrichtigung bei vollem Wassertank (mit 5 Min. Verzögerung)
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const DEHUMIDIFIERS = [
    'midea.0.153931628343857',
    'midea.0.31885837417521'
];

const WHATSAPP_RECIPIENTS = [
    'whatsapp-cmb.1.sendMessage', // Ralf
    'whatsapp-cmb.0.sendMessage'  // Marion
];

// Speicher für die Timer der einzelnen Geräte
const tankTimers = {};

for (const devId of DEHUMIDIFIERS) {
    // Wir triggern auf jede Änderung ('ne'), um auch das Zurücksetzen auf 'false' zu erfassen
    // @ts-ignore
    on({id: devId + ".status.tankFull", change: 'ne'}, (obj) => {
        
        if (obj.state.val === true) {
            // Falls aus irgendeinem Grund schon ein Timer läuft, diesen sicherheitshalber löschen
            if (tankTimers[devId]) clearTimeout(tankTimers[devId]);
            
            // Timer für 5 Minuten (5 * 60 * 1000 Millisekunden) starten
            tankTimers[devId] = setTimeout(() => {
                const name = getValue(devId + ".info.name") || "Luftentfeuchter";
                const message = `⚠️ *Luftentfeuchter*: Der Tank von *${name}* ist seit 5 Minuten voll und muss geleert werden!`;
                
                for (const waId of WHATSAPP_RECIPIENTS) {
                    if (existsStateIOB(waId)) {
                        setStateIOB(waId, message);
                    }
                }
                log(message, 'info');
                
                // Timer-Referenz nach Ausführung löschen
                tankTimers[devId] = null;
            }, 5 * 60 * 1000);
            
            log(`Luftentfeuchter ${devId}: Tank voll gemeldet. Timer für 5 Minuten gestartet.`, 'info');
            
        } else {
            // Wenn der Status wieder false wird, löschen wir den Timer, damit keine Nachricht gesendet wird
            if (tankTimers[devId]) {
                clearTimeout(tankTimers[devId]);
                tankTimers[devId] = null;
                log(`Luftentfeuchter ${devId}: Tank ist nicht mehr voll. Timer abgebrochen.`, 'info');
            }
        }
    });
}

// Shelly für Zendure Akkus: Ladung/Entladung berechnen

const energy = 'shelly.0.shellypmminig3#543204403244#1.PM1:0.Energy';
const returnedEnergy = 'shelly.0.shellypmminig3#543204403244#1.PM1:0.ReturnedEnergy';
const ladung = '0_userdata.0.PV.Zendure/Ladung';

function berechneLadung() {
    // 2 Sekunden warten, damit sicher 'energy' und 'returnedEnergy' uptodate sind:
    setTimeout(() => {
        const valEnergy = (getState(energy).val as number) || 0;
        const valReturned = (getState(returnedEnergy).val as number) || 0;
        
        const valLadung = valEnergy - valReturned; 

        setState(ladung, valLadung, true);
    }, 2000);
}

// Trigger für beide Quell-Datenpunkte
on({id: energy, change: "ne"}, berechneLadung);

// nicht nötig: wenn 'returnedEnergy' sich ändert, dann ändert sich auch immer 'energy':
//on({id: returnedEnergy, change: "ne"}, berechneLadung);
