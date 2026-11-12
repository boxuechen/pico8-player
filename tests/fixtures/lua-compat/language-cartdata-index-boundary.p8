pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 cartdata("phase9_index")
 dset(0,7)
 dset(-1,9)
 dset(64,9)
 poke(0x5000,dget(0),dget(-1),dget(64))
end
function _update() end
function _draw() end
