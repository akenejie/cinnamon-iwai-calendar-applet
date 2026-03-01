/* global imports */
/* eslint camelcase: "off" */

const Soup = imports.gi.Soup;
const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib; // ← この行を追加
const Utils = require("./utils");
const AppletDir = imports.ui.appletManager.appletMeta["calendar@akenejie"].path;

const MSECS_IN_DAY = 24 * 60 * 60 * 1000;

const Langinfo = Utils.getInfo("LC_ADDRESS");
const LC_LANG = Langinfo.lang_ab;

let _httpSession;
if (Soup.MAJOR_VERSION === 2) {
    _httpSession = new Soup.SessionAsync();
    Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());
} else { //version 3
    _httpSession = new Soup.Session();
}

const UPDATE_PERIOD = 24 * 60 * 60 * 1000 * 50; // last number is num of days

class Provider {
    static loadFile (fn) {
        try {
            return Gio.file_new_for_path(Provider.path + fn);
        } catch(e) {
            global.log(e);
        }
    }

    loadFromFile (fn, country) {
        const file = Provider.loadFile(fn);
        const struct = { years: {}, holidays: []};

        return file ? Object.assign(struct, Utils.readJsonFile(file)[country]) : struct;
    }

    writeToFile (fn, data) {
        const file = Provider.loadFile(fn);
        if (!file) {
            return;
        }

        const allData = Utils.readJsonFile(file);
        allData[this.country] = data;

        Utils.writeJsonFile(file, allData);
    }

    static loadJsonAsync(url, params, callback) {
        const message = Soup.Message.new("GET", url);
        global.log("get", url);
        
        if (Soup.MAJOR_VERSION === 2) {
            _httpSession.queue_message(message, (session, message) => {
                const retrieved = message.response_headers.get_one("date");
                const data = JSON.parse(message.response_body.data);
                global.log("response", retrieved);

                callback(data, params, retrieved);
            });
        } else { //version 3
            _httpSession.send_and_read_async(message, Soup.MessagePriority.NORMAL, null, (session, result) => {
                const retrieved = message.get_response_headers().get_one("date");
                const bytes = _httpSession.send_and_read_finish(result);
                const data = JSON.parse(ByteArray.toString(bytes.get_data()));
                global.log("response", retrieved);

                callback(data, params, retrieved);
            });
        }
    }
}
Provider.path = AppletDir;

class Enrico extends Provider {
    constructor () {
        super();

        this.years = {};
        this.data = [];
    }

    addUnique (single) {
        const known = this.data.find((d) => d.year === single.year && 
                d.month === single.month && d.day === single.day && d.region === this.region);

        if (known) {
            if (!known.name.split('\n').includes(single.name)) {
                known.name += '\n' + single.name;                
            }
        } else {
            this.data.push(single);
        }
    }

    update (holiday) {
        const {year, month, day} = holiday.date;

        const name = holiday.name
            .filter((l) => l.lang === LC_LANG || l.lang === "en")
            .sort((a, b) => a.lang === "en" ? 1 : b.lang === "en" ? -1 : 0)[0]
            .text;

        const flags = holiday.flags;

        this.addUnique({year, month, day, name, flags, region: this.region});

        if (holiday.dateTo) {
            const {year: yearTo, month: monthTo, day: dayTo} = holiday.dateTo;

            let iter = new Date(year, month, day, 12);
            let limit = new Date(yearTo, monthTo, dayTo, 12);
            do {
                iter.setTime(iter.getTime() + MSECS_IN_DAY);
                this.addUnique({
                    year: iter.getFullYear(),
                    month: iter.getMonth(),
                    day: iter.getDate(),
                    name,
                    flags,
                    region: this.region
                });
            } while (iter < limit);
        }
    }

    addData (data, params, retrieved) {
        if (data.error) {
            return;
        }

        const regionId = params.region || "global";
        if (this.years[params.year]) {
            this.years[params.year][regionId] = retrieved;
        } else {
            this.years[params.year] = {[regionId]: retrieved};
        }
        data.forEach(this.update, this);

        this.writeToFile(Enrico.fn, {
            years: this.years,
            holidays: this.data
        });
    }

    retrieveForYear (year, callback) {
        if (!this.country) {
            throw new Error("invalid country");
        }

        // 設定された国が日本の場合、内閣府のCSVから取得する処理に分岐
        const isJapan = this.country.toLowerCase() === "jpn" || 
                        this.country.toLowerCase() === "jp" || 
                        this.country.toLowerCase() === "japan";
        
        if (isJapan) {
            this.retrieveJapanCabinet(year, callback);
            return;
        }

        const params = {
            year,
            country: this.country,
            holidayType: "public_holiday"
        };
        if (this.region !== "global") {
            params.region = this.region;
        }

        let url = Enrico.url;
        for (let key of Object.keys(params)) {
            url += "&" + key + "=" + params[key];
        }

        Provider.loadJsonAsync(url, params, (data, params, date) => {
            this.addData(data, params, date);
            if (callback) {
                callback();
            }
        });
    }

    // 内閣府のCSVを取得・パース・変換するメソッド
    retrieveJapanCabinet (year, callback) {
        const url = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";
        const message = Soup.Message.new("GET", url);
        global.log("get", url);

        const params = { year, country: this.country, region: "global" };

        const processCsv = (rawBytes, retrievedDate) => {
            let utf8Text = "";

            try {
                // 最新のGJS環境用: TextDecoderを利用
                if (typeof TextDecoder !== 'undefined') {
                    const decoder = new TextDecoder('shift-jis');
                    utf8Text = decoder.decode(rawBytes);
                } else {
                    // 古いGJS環境用: GLib.convertを利用してShift-JISからUTF-8へ変換
                    const byteArray = rawBytes instanceof Uint8Array ? rawBytes : ByteArray.fromArray(rawBytes);
                    const [converted] = GLib.convert(byteArray, byteArray.length, "UTF-8", "SHIFT_JIS", null);
                    utf8Text = ByteArray.toString(converted);
                }
            } catch (e) {
                global.logError("Shift-JIS conversion failed: " + e);
                return;
            }

            const lines = utf8Text.split('\n');
            const data = [];

            // 1行目はヘッダーなので i=1 から開始
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                const parts = line.split(',');
                if (parts.length < 2) continue;

                const dateStr = parts[0];
                const name = parts[1];

                // 日付文字列をパース (スラッシュ または ハイフン区切りに対応)
                const dateParts = dateStr.split(/[\/\-]/);
                if (dateParts.length < 3) continue;

                const dYear = parseInt(dateParts[0], 10);
                const dMonth = parseInt(dateParts[1], 10);
                const dDay = parseInt(dateParts[2], 10);

                // APIのJSONフォーマットに合わせる (指定年以外のデータも除外せずに全て格納)
                data.push({
                    date: {
                        year: dYear,
                        month: dMonth,
                        day: dDay
                    },
                    name: [
                        { lang: "ja", text: name },
                        { lang: "en", text: name } // 英語環境でもエラーを回避するため同じ名称を設定
                    ],
                    holidayType: "public_holiday"
                });
            }

            // 変換した配列データを既存のメソッドへ流し込む
            this.addData(data, params, retrievedDate);
            if (callback) {
                callback();
            }
        };

        if (Soup.MAJOR_VERSION === 2) {
            _httpSession.queue_message(message, (session, message) => {
                const retrieved = message.response_headers.get_one("date");
                processCsv(message.response_body.data, retrieved);
            });
        } else { // version 3
            _httpSession.send_and_read_async(message, Soup.MessagePriority.NORMAL, null, (session, result) => {
                const retrieved = message.get_response_headers().get_one("date");
                const bytes = _httpSession.send_and_read_finish(result);
                processCsv(bytes.get_data(), retrieved);
            });
        }
    }

    staleCache (year) {
        if (this.years[year]) {
            const retrieved = this.years[year][this.region];
            if (retrieved &&  Date.now() - new Date(retrieved).getTime() < UPDATE_PERIOD) {
                return false;
            }
        }

        return true;
    }

    setPlace (country, region = "global") {
        if (this.country !== country) {
            const data = this.loadFromFile(Enrico.fn, country);
            this.years = data.years;
            this.data = data.holidays;
        }

        this.country = country;
        this.region = region;

        const year = new Date().getFullYear();
        if (this.staleCache(year) || this.region && !this.years[year][this.region]) {
            this.retrieveForYear(year);
        }
    }

    matchMonth (year, month) {
        const holidays = this.data.filter((d) => d.year == year && d.month == month && d.region == this.region);
        return new Map(holidays.map((d) => [`${d.month}/${d.day}`, [d.name, d.flags]]));
    }

    getHolidays (year, month, callback) {
        if (this.staleCache(year)) {
            this.retrieveForYear(year, () => {
                callback(this.matchMonth(year, month));
            });
        } else {
            callback(this.matchMonth(year, month));
        }
    }
}
Enrico.url = "https://kayaposoft.com/enrico/json/v2.0?action=getHolidaysForYear";
Enrico.fn = "/enrico.json";

class HolidayData {
    constructor (source = "enrico") {
        this._init(source);
    }

    _init (source) {
        if (HolidayData.validSources.hasOwnProperty(source)) {
            this._provider = new HolidayData.validSources[source]();
        }
    }

    getProvider () {
        return this._provider;
    }
}
HolidayData.validSources = {
    enrico: Enrico
};
