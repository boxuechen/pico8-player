pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 load("missing-cart.p8","unreachable","missing")
 poke(0x5000,0xff)
end
