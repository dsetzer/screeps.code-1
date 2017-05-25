/**
 * To start using Traveler, require it in main.js:
 *
 * There are 6 options available to pass to the module. Options are passed in the form
 *   of an object with one or more of the following:
 *
 *   exportTraveler:    boolean    Whether the require() should return the Traveler class. Defaults to true.
 *   installTraveler:   boolean    Whether the Traveler class should be stored in `global.Traveler`. Defaults to false.
 *   installPrototype:  boolean    Whether Creep.prototype.travelTo() should be created. Defaults to true.
 *   hostileLocation:   string     Where in Memory a list of hostile rooms can be found. If it can be found in
 *                                   Memory.empire, use 'empire'. Defaults to 'empire'.
 *   maxOps:            integer    The maximum number of operations PathFinder should use. Defaults to 20000
 *   defaultStuckValue: integer    The maximum number of ticks the creep is in the same RoomPosition before it
 *                                   determines it is stuck and repaths.
 *   reportThreshold:   integer    The mimimum CPU used on pathing to console.log() warnings on CPU usage. Defaults to 50
 *
 * Examples: var Traveler = require('Traveler')();
 *           require('util.traveler')({exportTraveler: false, installTraveler: false, installPrototype: true, defaultStuckValue: 2});
 */
module.exports = function(globalOpts = {}){
    const gOpts = _.defaults(globalOpts, {
        exportTraveler:    true,
        installTraveler:   false,
        installPrototype:  true,
        maxOps:            20000,
        defaultStuckValue: 3,
        reportThreshold:   50,
        roomRange:         22,
    });
    class Traveler {
        constructor(validTick) {
            this.validTick = validTick;
            this.reverseDirection = {
                TOP:BOTTOM,
                TOP_RIGHT:BOTTOM_LEFT,
                RIGHT:LEFT,
                BOTTOM_RIGHT:TOP_LEFT,
                BOTTOM:TOP,
                BOTTOM_LEFT:TOP_RIGHT,
                LEFT:RIGHT,
                TOP_LEFT:BOTTOM_RIGHT
            };
            this.getHostileRoom = (roomName) => _.get(Memory, ['rooms', roomName, 'hostile']);
            this.registerHostileRoom = (room) => room.registerIsHostile();
        }
        findAllowedRooms(origin, destination, _options = {}) {
            const options = { restrictDistance: 16 };
            _.merge(options, _options);
            if (Game.map.getRoomLinearDistance(origin, destination) > options.restrictDistance) {
                return;
            }
            let allowedRooms = { [origin]: true, [destination]: true };
            let ret = Game.map.findRoute(origin, destination, {
                routeCallback: (roomName) => {
                    if (options.routeCallback) {
                        let outcome = options.routeCallback(roomName);
                        if (outcome !== undefined) {
                            return outcome;
                        }
                    }
                    if (Game.map.getRoomLinearDistance(origin, roomName) > options.restrictDistance) {
                        return false;
                    }
                    let parsed;
                    if (options.preferHighway) {
                        parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
                        let isHighway = (parsed[1] % 10 === 0) || (parsed[2] % 10 === 0);
                        if (isHighway) {
                            return 1;
                        }
                    }
                    if (!options.allowSK && !Game.rooms[roomName]) {
                        if (!parsed) {
                            parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
                        }
                        let fMod = parsed[1] % 10;
                        let sMod = parsed[2] % 10;
                        let isSK = !(fMod === 5 && sMod === 5) &&
                            ((fMod >= 4) && (fMod <= 6)) &&
                            ((sMod >= 4) && (sMod <= 6));
                        if (isSK) {
                            return 10;
                        }
                    }
                    if (!options.allowHostile && this.getHostileRoom(roomName) &&
                        roomName !== destination && roomName !== origin) {
                        return Number.POSITIVE_INFINITY;
                    }
                    return 2.5;
                }
            });
            if (options.debug && !_.isArray(ret)) {
                console.log(`couldn't findRoute to ${destination}`);
                return;
            }
            for (let value of ret) {
                allowedRooms[value.room] = true;
            }
            allowedRooms.route = ret;
            return allowedRooms;
        }
        findTravelPath(origin, destination, _options = {}) {
            const options = {
                ignoreCreeps: true,
                range: 1,
                maxOps: gOpts.maxOps,
                obstacles: [],
            };
            _.assign(options, _options);
            let origPos = (origin.pos || origin), destPos = (destination.pos || destination);
            let allowedRooms;
            if (options.useFindRoute || (options.useFindRoute === undefined &&
                Game.map.getRoomLinearDistance(origPos.roomName, destPos.roomName) > 2)) {
                allowedRooms = this.findAllowedRooms(origPos.roomName, destPos.roomName, options);
            }
            let callback = (roomName) => {
                if (options.roomCallback) {
                    let outcome = options.roomCallback(roomName, options.ignoreCreeps);
                    if (outcome !== undefined) {
                        return outcome;
                    }
                }
                if (allowedRooms) {
                    if (!allowedRooms[roomName]) {
                        return false;
                    }
                } else if (this.getHostileRoom(roomName) && !options.allowHostile &&
                    roomName !== origPos.roomName && roomName !== destPos.roomName) {
                    return false;
                }

                let room = Game.rooms[roomName];
                let matrix;
                if (!room) {
                    matrix = this.getStructureMatrix(roomName, options);
                } else if (options.ignoreStructures) {
                    matrix = new PathFinder.CostMatrix();
                    if (!options.ignoreCreeps) {
                        Traveler.addCreepsToMatrix(room, matrix);
                    }
                } else if (options.ignoreCreeps || roomName !== origin.pos.roomName) {
                    matrix = this.getStructureMatrix(room, options);
                } else {
                    matrix = this.getCreepMatrix(room, options);
                }
                for (let obstacle of options.obstacles) {
                    matrix.set(obstacle.pos.x, obstacle.pos.y, 0xff);
                }
                return matrix;
            };
            const ret = PathFinder.search(origPos, { pos: destPos, range: options.range }, {
                maxOps: options.maxOps,
                plainCost: options.ignoreRoads ? 1 : 2,
                roomCallback: callback,
                swampCost: options.ignoreRoads ? 5 : 10,
            });
            ret.route = allowedRooms && allowedRooms.route;
            return ret;
        }
        static isBorder(pos) {
            return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
        };
        static opposingBorders(p1, p2) {
            return Traveler.isBorder(p1) && Traveler.isBorder(p2) && p1.roomName !== p2.roomName && (p1.x === p2.x || p1.y === p2.y);
        };
        prepareTravel(creep, destPos, options) {
            const p = Util.startProfiling('prepareTravel', {enabled: false});
            // initialize data object
            if (_.isUndefined(creep.memory._travel)) {
                creep.memory._travel = { stuck: 0, tick: Game.time, cpu: 0, count: 0 };
            }
            const travelData = creep.memory._travel;
            const creepPos = creep.pos;
            p.checkCPU('', 5, 'prepareTravel:init1');

            if (creep.fatigue) {
                travelData.tick = Game.time;
                return ERR_BUSY;
            }
            p.checkCPU('', 5, 'prepareTravel:init2');
            if (!destPos) {
                return ERR_INVALID_ARGS;
            }
            p.checkCPU('', 5, 'prepareTravel:init3');
            // check if creep is stuck
            if (travelData.prev) {
                if ((creepPos.x === travelData.prev.x && creepPos.y === travelData.prev.y && creepPos.roomName === travelData.prev.roomName) ||
                    Traveler.opposingBorders(creepPos, travelData.prev)) {
                    travelData.stuck++;
                } else {
                    if (global.ROAD_CONSTRUCTION_ENABLE) creep.room.recordMove(creep);
                    p.checkCPU('', 5, 'prepareTravel:recordMove');
                    travelData.stuck = 0;
                    if (creepPos.roomName === destPos.roomName && (!travelData.checkRange || Game.time > travelData.checkRange)) {
                        // manage case where creep is nearby destination
                        let rangeToDestination = creepPos.getRangeTo(destPos.x, destPos.y);
                        p.checkCPU('getRange', 5, 'prepareTravel:getRange');
                        if (rangeToDestination <= options.range) {
                            return OK;
                        } else if (rangeToDestination <= 1) {
                            if (rangeToDestination === 1 && !options.range) {
                                if (options.returnData) {
                                    options.returnData.nextPos = destPos;
                                }
                                return creep.move(creepPos.getDirectionTo(destPos));
                            }
                            return OK;
                        } else {
                            travelData.checkRange = Game.time + (rangeToDestination - options.range);
                        }
                    }
                    p.checkCPU('', 5, 'prepareTravel:beforeHostile');
                    if (creepPos.roomName !== travelData.prev.roomName) {
                        this.registerHostileRoom(creep.room);
                        p.checkCPU('getRange', 5, 'prepareTravel:registerHostileRoom');
                    }
                }
            }
            if (travelData.stuck >= gOpts.defaultStuckValue && !options.ignoreStuck) {
                options.stuck = true;
            }
            travelData.tick = Game.time;
            p.checkCPU('', 5, 'prepareTravel:return');
        }
        travelTo(creep, destPos, options = {}) {
            const p = Util.startProfiling('', {enabled:false});
            const travelData = creep.memory._travel;
            const creepPos = creep.pos;
            // handle case where creep is stuck
            if (options.stuck) {
                options.ignoreCreeps = false;
                delete travelData.path;
            }
            p.checkCPU('', 1, 'travelTo:init1');
            // delete path cache if destination is different
            if (!travelData.dest || travelData.dest.x !== destPos.x || travelData.dest.y !== destPos.y ||
                travelData.dest.roomName !== destPos.roomName) {
                delete travelData.path;
            }
            p.checkCPU('', 1, 'travelTo:init2');
            // pathfinding
            if (!travelData.path) {
                if (creep.spawning) {
                    return ERR_BUSY;
                }
                p.checkCPU('', 1, 'travelTo:spawning');
                travelData.dest = destPos;
                travelData.prev = undefined;
                let ret;
                if (global.TRAVELER_USAGE) {
                    let cpu = Game.cpu.getUsed();
                    p.checkCPU('', 1, 'travelTo:getUsed');
                    ret = this.findTravelPath(creep, destPos, options);
                    p.checkCPU('', 1, 'travelTo:findTravelPath');
                    travelData.cpu += (Game.cpu.getUsed() - cpu);
                    travelData.count++;
                    travelData.avg = _.round(travelData.cpu / travelData.count, 2);
                    if (travelData.count > 25 && travelData.avg > options.reportThreshold) {
                        if (options.debug){
                            console.log(`TRAVELER: heavy cpu use: ${creep.name}, avg: ${travelData.cpu / travelData.count}, total: ${_.round(travelData.cpu, 2)},` +
                                `origin: ${creep.pos}, dest: ${destPos}`);
                        }
                    }
                    p.checkCPU('', 1, 'travelTo:reportThreshold');
                } else {
                    ret = this.findTravelPath(creep, destPos, options);
                    p.checkCPU('', 1, 'travelTo:findTravelPath');
                }
                if (ret.incomplete) {
                    const route = ret.route && ret.route.length;
                    if (options.debug) {
                        if (options.range === 0) {
                            console.log(`TRAVELER: incomplete path for ${creep.name} from ${creep.pos} to ${destPos}, destination may be blocked.`);
                        } else {
                            console.log(`TRAVELER: incomplete path for ${creep.name} from ${creep.pos} to ${destPos}, range ${options.range}. Route length ${route}.`);
                        }
                    }
                    if (route > 1) {
                        ret = this.findTravelPath(creep, new RoomPosition(25, 25, ret.route[1].room),
                            _.create(options, {
                                range: gOpts.roomRange,
                                useFindRoute: false,
                            }));
                        p.checkCPU('', 1, 'travelTo:alternate1')
                        if (options.debug) {
                            console.log(`attempting path through next room using known route was ${ret.incomplete ? "not" : ""} successful`);
                        }
                    }
                    if (ret.incomplete && ret.ops < 2000 && travelData.stuck < gOpts.defaultStuckValue) {
                        options.useFindRoute = false;
                        ret = this.findTravelPath(creep, destPos, options);
                        p.checkCPU('', 1, 'travelTo:alternate2')
                        if (options.debug) {
                            console.log(`attempting path without findRoute was ${ret.incomplete ? "not " : ""}successful`);
                        }
                    }
                }
                travelData.path = Traveler.serializePath(creepPos, ret.path);
                p.checkCPU('', 1, 'travelTo:serializePath')
                travelData.stuck = 0;
            }
            if (!travelData.path || travelData.path.length === 0) {
                return ERR_NO_PATH;
            }
            // consume path and move
            if (travelData.prev && travelData.stuck === 0) {
                travelData.path = travelData.path.substr(1);
            }
            p.checkCPU('', 1, 'travelTo:substr')
            travelData.prev = creepPos;
            let nextDirection = parseInt(travelData.path[0], 10);
            if (options.returnData) {
                options.returnData.nextPos = Traveler.positionAtDirection(creepPos, nextDirection);
            }
            p.checkCPU('', 1, 'travelTo:nextDirection');
            const ret = creep.move(nextDirection);
            p.checkCPU('', 1, 'travelTo:move')
            return ret;
        }
        travelByPath(creep, destPos, options) {
            const p = Util.startProfiling('', {enabled:false});
            const travelData = creep.memory._travel;
            const creepPos = creep.pos;
            let next;
            if (options.stuck || travelData.detour) {
                if (!travelData.detour) {
                    // get the next 5 spots on the path
                    options.fullPath = true;
                    const ret = options.getPath(creep.room, creepPos, destPos, options);
                    const goals = [];
                    let lastPos = creepPos;
                    let nextPos;
                    for (let i = 0; i < 5 && ret.path.length; i++) {
                        const posId = Traveler.getPosId(lastPos);
                        const direction = ret.reverse ? Traveler.reverseDirection(path[posId]) : path[posId];
                        nextPos = Traveler.positionAtDirection(lastPos, direction);
                        if (!nextPos) break; // in case we hit a border
                        goals.push(nextPos);
                        lastPos = nextPos;
                    }
                    options.ignoreCreeps = false; // creeps are the most common reason for a detour
                    travelData.detour = traveler.findDetour(creepPos, goals, options);
                    if (!travelData.detour && options.debug) {
                        console.log(creep.name, creepPos, 'could not find a detour, reverting to travelTo');
                        travelData.cachedRoute.shouldCache = false;
                        return;
                    }
                }
                if (travelData.detour) {
                    next = parseInt(travelData.detour.shift(), 10);
                    if (!travelData.detour.length) delete travelData.detour;
                    p.checkCPU('Traveler.travelByPath', 1, 'travelByPath:detour');
                }
            } else {
                next = options.getPath(creep.room, creepPos, destPos, options);
                p.checkCPU('Traveler.travelByPath', 1, 'travelByPath:getPath');
            }
            if (next) {
                travelData.prev = creepPos;
                delete travelData.path; // clean up other memory usage
                if (next === 'B') return OK; // wait for border to cycle
                else {
                    const ret = creep.move(next); // take next step
                    p.checkCPU('Traveler.travelByPath', 3, 'travelByPath:move');
                    return ret;
                }
            } else if (options.debug) {
                console.log(creep.name, 'Could not generate or use cached route, falling back to traveler.', next, 'from', creepPos, 'to', destPos);
            }
        }
        getStructureMatrix(room, options) {
            if (options.getStructureMatrix) return options.getStructureMatrix(room);
            this.refreshMatrices();
            if (!this.structureMatrixCache[room.name]) {
                let matrix = new PathFinder.CostMatrix();
                this.structureMatrixCache[room.name] = Traveler.addStructuresToMatrix(room, matrix, 1);
            }
            return this.structureMatrixCache[room.name];
        }
        static initPosition(pos) {
            return new RoomPosition(pos.x, pos.y, pos.roomName);
        }
        static addStructuresToMatrix(room, matrix, roadCost) {
            for (let structure of room.find(FIND_STRUCTURES)) {
                if (structure instanceof StructureRampart) {
                    if (!structure.my && !structure.isPublic) {
                        matrix.set(structure.pos.x, structure.pos.y, 0xff);
                    }
                }
                else if (structure instanceof StructureRoad) {
                    matrix.set(structure.pos.x, structure.pos.y, roadCost);
                }
                else if (structure.structureType !== STRUCTURE_CONTAINER) {
                    // Can't walk through non-walkable buildings
                    matrix.set(structure.pos.x, structure.pos.y, 0xff);
                }
            }
            for (let site of room.find(FIND_CONSTRUCTION_SITES)) {
                if (site.structureType === STRUCTURE_CONTAINER) {
                    continue;
                } else if (site.structureType === STRUCTURE_ROAD) {
                    continue;
                } else if (site.structureType === STRUCTURE_RAMPART) {
                    continue;
                }
                matrix.set(site.pos.x, site.pos.y, 0xff);
            }
            return matrix;
        }
        getCreepMatrix(room, options) {
            if (options.getCreepMatrix) return options.getCreepMatrix(room);
            this.refreshMatrices();
            if (!this.creepMatrixCache[room.name]) {
                this.creepMatrixCache[room.name] = Traveler.addCreepsToMatrix(room, this.getStructureMatrix(room, options).clone());
            }
            return this.creepMatrixCache[room.name];
        }
        static addCreepsToMatrix(room, matrix) {
            room.find(FIND_CREEPS).forEach((creep) => matrix.set(creep.pos.x, creep.pos.y, 0xff));
            return matrix;
        }
        static serializePath(startPos, path) {
            let serializedPath = "";
            let lastPosition = startPos;
            for (const position of path) {
                if (position.roomName === lastPosition.roomName) {
                    serializedPath += lastPosition.getDirectionTo(position);
                }
                lastPosition = position;
            }
            return serializedPath;
        }
        refreshMatrices() {
            if (Game.time !== this.currentTick) {
                this.currentTick = Game.time;
                this.structureMatrixCache = {};
                this.creepMatrixCache = {};
            }
        }
        // unique identifier for each position within the starting room
        // codes 13320 - 15819 represent positions, and are all single character, unique representations
        static getPosId(pos) {
            return String.fromCodePoint(13320 + (pos.x * 50) + pos.y);
        }
        static getPos(id, roomName) {
            if (!roomName) {
                const ret = id.split(',');
                roomName = ret[0];
                id = ret[1];
            }
            const total = id.codePointAt(0) - 13320
            const x = Math.floor(total / 50);
            const y = total % 50;
            return new RoomPosition(x, y, roomName);
        };
        // unique destination identifier for room positions
        static getDestId(pos) {
            return `${pos.roomName},${Traveler.getPosId(pos)}`;
        }
        static positionAtDirection(origin, direction) {
            if (!(direction >= 1 && direction <= 8)) return;
            let offsetX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
            let offsetY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
            return new RoomPosition(origin.x + offsetX[direction], origin.y + offsetY[direction], origin.roomName);
        }
        // try to find a path that links to the next closest spot on the path while considering creeps
        findDetour(startPos, goals, options) {
            const rval = PathFinder.search(
                startPos, goals, {
                    maxOps: 350,
                    maxRooms: 1,
                    algorithm: 'dijkstra',
                    roomCallback: roomName => {
                        if (options.ignoreCreeps) {
                            return options.getStructureMatrix(roomName, options);
                        } else {
                            const room = Game.rooms[roomName];
                            if (room) {
                                return options.getCreepMatrix(room, options);
                            }
                        }
                    }
                }
            );
            if (rval && !rval.incomplete) {
                return Traveler.serializePath(startPos, rval.path);
            }
        }
        static cacheThisRoute(creep, dest, options) {
            if (!options.cacheRoutes || options.ignoreCreeps === false) {
                return false;
            }
            const travelData = creep.memory._travel;
            // don't do expensive checks each tick once you've determined this destination is not to be cached
            const destId = Traveler.getDestId(dest);
            if (travelData.cachedRoute && travelData.cachedRoute.dest === destId) {
                return travelData.cachedRoute.shouldCache;
            }
            const shouldCache = options.cacheThisRoute ? options.cacheThisRoute(dest) : options.cacheRoutes;
            travelData.cachedRoute = {dest: destId, shouldCache};
            return shouldCache;
        }
    }

    if(gOpts.installTraveler){
        global.Traveler = Traveler;
        global.travelerTick = Game.time;
        global.traveler = new Traveler(global.travelerTick);
    }
    if(gOpts.installPrototype){
        // prototype requires an instance of traveler be installed in global
        if(!gOpts.installTraveler) {
            global.travelerTick = Game.time;
            global.traveler = new Traveler(global.travelerTick);
        }
        Creep.prototype.travelTo = function(destination, _options = {}) {
            let p = Util.startProfiling(this.name, {enabled: true});
            let p2 = Util.startProfiling(this.name, {enabled: false});
            if (_.isUndefined(global.traveler) || global.traveler.validTick !== global.travelerTick) global.traveler = new Traveler(global.travelerTick);
            destination = destination.pos || destination;
            if (!destination || !destination.roomName) return logError('Room.routeCallback', 'destination must be defined');

            _options = this.getStrategyHandler([this.data.actionName], 'moveOptions', _options);
            p2.checkCPU('Creep.travelTo', 1, 'Creep.travelTo:getStrategy');
            let options = {
                allowSK: true,
                avoidSKCreeps: true,
                debug: global.DEBUG,
                ignoreCreeps: true,
                reportThreshold: global.TRAVELER_THRESHOLD,
                useFindRoute: global.ROUTE_PRECALCULATION || true,
            };
            _.assign(options, _options);
            options.routeCallback = Room.routeCallback(this.pos.roomName, destination.roomName, options);
            options.getStructureMatrix = room => Room.getStructureMatrix(room.name || room, options);
            options.getCreepMatrix = room => room.getCreepMatrix(options.getStructureMatrix(room));
            p2.checkCPU('Creep.travelTo', 1, 'Creep.travelTo:defaults');

            let type = '';
            let ret = traveler.prepareTravel(this, destination, options);
            p2.checkCPU('Creep.travelTo', 1, 'Creep.travelTo:prepareTravel');
            if (_.isUndefined(ret)) {
                if (Traveler.cacheThisRoute(this, destination, options)) {
                    p2.checkCPU('', 1, 'Creep.travelTo:doCache');
                    type = 'Cached';
                    options.getPath = (room, startPos, destPos, options) => room.getPath(startPos, destPos, options);
                    ret = traveler.travelByPath(this, destination, options);
                    p2.checkCPU('', 1, 'Creep.travelTo:travelByPath');
                } else {
                    p2.checkCPU('', 1, 'Creep.travelTo:noCache');
                }
                if (_.isUndefined(ret)) {
                    ret = traveler.travelTo(this, destination, options);
                    p2.checkCPU('', 1, 'Creep.travelTo:travelTo');
                }
            }
            p.checkCPU('Creep.travelTo', 1, 'Creep.travelTo' + type + ':total');
            return ret;
        };
    }

    if(gOpts.exportTraveler){
        return Traveler;
    }
};
