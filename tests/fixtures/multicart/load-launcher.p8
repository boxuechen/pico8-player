pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 poke(0x5000,0xa1)
 load("chapter-b.p8","back to launcher","from-launcher")
 poke(0x5001,0xff)
end
